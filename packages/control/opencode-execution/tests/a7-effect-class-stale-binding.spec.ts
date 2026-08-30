/**
 * P1/P2 invariant carry-forward (A7): (1) effect-class metadata propagates to
 * the derived outbox working view (COMPENSATABLE/IRREVERSIBLE class survives
 * the fold), and (2) an old execution's correlated activity can never attach to
 * a newer execution's derived state — activity bindings are scoped to the
 * execution named in the canonical event, and a stale correlation after a new
 * execution begins still binds to its own execution.
 * @module @deepseek-ai/dsh-opencode-execution/tests/a7-effect-class-stale-binding
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, {
  type SqliteSessionPersistence,
} from '@deepseek-ai/dsh-session-persistence-sqlite'
import { ActionId, AttemptId, ExecutionId } from '@deepseek-ai/dsh-opencode-control'
import { CapabilityKernel, type EffectProposal } from '../src/capability.ts'
import { ExecutionRuntime } from '../src/execution-runtime.ts'
import { EffectExecutor, type EffectWorker } from '../src/effect-executor.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

/** A worker that succeeds immediately and records its class metadata. */
function makeClassWorker(operation: string, external: { rawCalls: number }): EffectWorker {
  return {
    operation,
    async execute(attempt) {
      external.rawCalls++
      return { kind: 'succeeded', receipt: { action_id: attempt.action_id, resource: attempt.resource } }
    },
  }
}

async function boot(path: string, sessionId: SessionId): Promise<{ ctx: Context; runtime: ExecutionRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
  await ctx.sessionPersistence.create({ version: 0, id: sessionId, createdAt: 1_000, cwd: '/workspace' })
  const runtime = new ExecutionRuntime({
    persistence: ctx.sessionPersistence as SqliteSessionPersistence,
    session_id: sessionId,
    writer: { worker_id: 'a7-class-w', ownership_epoch: 0 },
  })
  return { ctx, runtime }
}

describe('effect-class metadata + stale activity binding', () => {
  it('propagates COMPENSATABLE effect-class to the derived outbox working view', async () => {
    const path = await freshDbPath('dsh-a7-class-')
    const sessionId = SessionId('a7-class')
    const { ctx, runtime } = await boot(path, sessionId)
    const external = { rawCalls: 0 }
    const kernel = new CapabilityKernel()
    kernel.grant({
      id: 'cap-compensate',
      principal: 'model-session-1',
      operation: 'fs.move',
      resourceScope: 'fs:/srv/app/**',
      effectClasses: ['COMPENSATABLE'],
    })
    const executor = new EffectExecutor({
      runtime,
      kernel,
      workers: new Map([['fs.move', makeClassWorker('fs.move', external)]]),
    })
    const proposal: EffectProposal = {
      execution_id: 'exec-1',
      action_id: 'act:move:1',
      attempt_id: 'act:move:1:1',
      operation: 'fs.move',
      resource: 'fs:/srv/app/a.json',
      effect_class: 'COMPENSATABLE',
      proposer: 'model-session-1',
      payload: { target: 'fs:/srv/app/b.json' },
    }
    await runtime.beginExecution(ExecutionId('exec-1'), 'move file', 'surface')
    const result = await executor.execute(proposal)
    expect(result.result?.outcome.kind).toBe('succeeded')
    expect(external.rawCalls).toBe(1)

    // The derived outbox working view carries the COMPENSATABLE class through
    // to the terminal state.
    const outbox = await executor.outbox()
    const record = outbox.find((entry) => entry.action_id === ActionId('act:move:1'))
    expect(record?.effect_class).toBe('COMPENSATABLE')
    expect(record?.state).toBe('succeeded')
    expect(record?.operation).toBe('fs.move')
    await ctx.fiber.dispose()
  })

  it('binds each correlated activity to ITS OWN execution even after a newer execution begins', async () => {
    const path = await freshDbPath('dsh-a7-stale-')
    const sessionId = SessionId('a7-stale')
    const { ctx, runtime } = await boot(path, sessionId)
    const exec1 = ExecutionId('exec-1')
    const exec2 = ExecutionId('exec-2')

    await runtime.beginExecution(exec1, 'first task', 'surface')
    await runtime.correlateActivity(exec1, 3, 'shell.stdout')
    // A NEW execution begins; then a STALE correlation for exec-1 arrives.
    await runtime.beginExecution(exec2, 'second task', 'surface')
    await runtime.correlateActivity(exec1, 9, 'shell.stdout')

    const derived = await runtime.derive()
    const exec1State = derived.executions.get(exec1)
    const exec2State = derived.executions.get(exec2)
    expect(exec1State?.native_event_seqs).toEqual([3, 9])
    expect(exec2State?.native_event_seqs).toEqual([])

    // Every activity record binds to exec-1; exec-2's derived state never
    // contains exec-1's activity seqs.
    for (const activity of derived.activities) {
      expect(activity.execution_id).toBe(exec1)
    }
    expect(derived.activities.map((activity) => activity.native_event_seq)).toEqual([3, 9])
    await ctx.fiber.dispose()
  })

  it('an effect attempt cannot succeed for an action the attempt was never started for', async () => {
    const path = await freshDbPath('dsh-a7-attempt-')
    const sessionId = SessionId('a7-attempt')
    const { ctx, runtime } = await boot(path, sessionId)
    const execution = ExecutionId('exec-1')
    const action = ActionId('act-ghost')
    await runtime.beginExecution(execution, 'x', 'surface')
    // succeedEffect for an action with no attempt-started must reject.
    await expect(runtime.succeedEffect(execution, action, AttemptId('act-ghost:1'), { ok: true }))
      .rejects.toThrow(/effect result without prior attempt/)
    await ctx.fiber.dispose()
  })
})
