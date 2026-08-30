/**
 * A5 full ambiguous-effect recovery with REAL DSH persistence across a process
 * boundary. The complete canonical path:
 *   effect/requested → effect/authorized → [durable checkpoint]
 *   → effect/attempt-started → [external may commit, response disappears]
 *   → effect/commit-unknown → [crash] → fresh runtime → delete/rebuild
 *   projection → derive ambiguity from DSH → reconcile external state
 *   → effect/reconciled (distinct attempt id, reconcile:true) → [checkpoint]
 *   → fresh fold → state = reconciled. A second restart must remain
 *   reconciled. No blind re-dispatch, stable action_id, and NO projection-only
 *   write anywhere.
 * @module @deepseek-ai/dsh-opencode-execution/tests/a5-ambiguous-effect-recovery
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, { type SqliteSessionPersistence } from '@deepseek-ai/dsh-session-persistence-sqlite'
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

const CHILD_SRC_PATH = join(import.meta.dirname, 'fixtures', 'a5-reconcile-child.mjs')

/**
 * Spawn a real child node process that reconciles the ambiguous effect against
 * the fake external system (or, with deriveOnly, only derives the canonical
 * state), reading only the DSH DB. Returns the child's printed facts.
 */
function childReconcile(
  dbPath: string,
  sessionId: string,
  actionId: string,
  resource: string,
  preSeed?: Map<string, string>,
  deriveOnly = false,
): Record<string, string> {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx/esm', CHILD_SRC_PATH, dbPath, sessionId, actionId, resource],
    {
      encoding: 'utf8',
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      env: {
        ...process.env,
        ...(deriveOnly ? { A5_DERIVE_ONLY: '1' } : {}),
        ...(preSeed === undefined ? {} : { A5_PRE_SEED: [...preSeed].map(([k, v]) => `${k}=${v}`).join(';') }),
      },
    },
  )
  const facts: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) facts[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return facts
}

/** Boot a fresh runtime over one session on a real DB file. */
async function boot(path: string, sessionId: SessionId): Promise<{ ctx: Context; runtime: ExecutionRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
  await ctx.sessionPersistence.create({ version: 0, id: sessionId, createdAt: 1_000, cwd: '/workspace' })
  const runtime = new ExecutionRuntime({
    persistence: ctx.sessionPersistence as SqliteSessionPersistence,
    session_id: sessionId,
    writer: { worker_id: `worker-${process.pid}`, ownership_epoch: 0 },
  })
  await runtime.beginExecution(ExecutionId('exec-1'), 'apply patch', 'surface')
  return { ctx, runtime }
}

function patchProposal(over: Partial<EffectProposal> = {}): EffectProposal {
  return {
    execution_id: 'exec-1',
    action_id: 'act:patch:1',
    attempt_id: 'act:patch:1:1',
    operation: 'fs.patch',
    resource: 'fs:/srv/app/seed.json',
    effect_class: 'IRREVERSIBLE',
    proposer: 'model-session-1',
    payload: { patch: 'DELETE /seed.json' },
    ...over,
  }
}

/** An IRREVERSIBLE worker: reconcile probes external state, never re-applies. */
function makeIrreversibleWorker(external: { db: Map<string, string>; loseResponse: boolean; rawCalls: number }): EffectWorker {
  return {
    operation: 'fs.patch',
    async execute(attempt) {
      external.rawCalls++
      if (attempt.reconcile) {
        if (external.db.has(attempt.resource)) {
          return { kind: 'succeeded', receipt: { resource: attempt.resource, reconciled: true } }
        }
        return { kind: 'failed', error: 'not committed' }
      }
      if (external.loseResponse) {
        external.loseResponse = false
        external.db.set(attempt.resource, String(attempt.payload))
        return { kind: 'commit-unknown' }
      }
      external.db.set(attempt.resource, String(attempt.payload))
      return { kind: 'succeeded', receipt: { resource: attempt.resource } }
    },
  }
}

describe('A5 full ambiguous-effect recovery (process boundary)', () => {
  it('recovers commit-unknown → reconcile → effect/reconciled across a real process boundary, and a second restart stays reconciled', async () => {
    const path = await freshDbPath('dsh-a5-')
    const sessionId = SessionId('a5-ambiguous')
    const external = { db: new Map<string, string>(), loseResponse: false, rawCalls: 0 }

    // Phase 1: write through effect/authorized, attempt-started, then the
    // external system commits but the response is lost → commit-unknown.
    const { ctx, runtime } = await boot(path, sessionId)
    const kernel = new CapabilityKernel()
    kernel.grant({
      id: 'cap-patch',
      principal: 'model-session-1',
      operation: 'fs.patch',
      resourceScope: 'fs:/srv/app/**',
      effectClasses: ['IRREVERSIBLE'],
    })
    const executor = new EffectExecutor({
      runtime,
      kernel,
      workers: new Map([['fs.patch', makeIrreversibleWorker(external)]]),
    })
    external.loseResponse = true
    const r1 = await executor.execute(patchProposal())
    expect(r1.result?.outcome.kind).toBe('commit-unknown')
    expect(external.db.has('fs:/srv/app/seed.json')).toBe(true) // external committed
    expect(external.rawCalls).toBe(1) // no blind retry
    await ctx.fiber.dispose() // CRASH: parent runtime gone

    // Phase 2: a REAL child process opens only the DSH DB, derives the
    // ambiguity, and reconciles against the external system's truth.
    const child = childReconcile(
      path,
      String(sessionId),
      'act:patch:1',
      'fs:/srv/app/seed.json',
      external.db, // the fake external system's committed state, shared across processes
    )
    expect(child.BEFORE_OUTCOME).toBe('commit-unknown')
    expect(child.RECONCILE_RESULT).toBe('succeeded')
    expect(child.RECONCILE_ATTEMPT).toBe('act:patch:1:reconcile:1')
    expect(child.AFTER_OUTCOME).toBe('reconciled')
    expect(child.ATTEMPT_IDS).toContain('act:patch:1:1')
    expect(child.ATTEMPT_IDS).toContain('act:patch:1:reconcile:1')

    // Phase 3: a second restart (fresh process) derives the canonical log and
    // the rebuilt projection reports reconciled. Derive-only: no mutation.
    const child2 = childReconcile(
      path,
      String(sessionId),
      'act:patch:1',
      'fs:/srv/app/seed.json',
      external.db,
      true,
    )
    expect(child2.AFTER_OUTCOME).toBe('reconciled')

    // Phase 4: a fresh in-process runtime over the persisted DSH log agrees.
    const verify = new Context()
    await verify.plugin(SessionStore)
    await verify.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    const verifyRuntime = new ExecutionRuntime({
      persistence: verify.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: `verify-${process.pid}`, ownership_epoch: 0 },
    })
    const derived = await verifyRuntime.derive()
    const effect = derived.effects.get(ActionId('act:patch:1'))
    expect(effect?.outcome).toBe('reconciled')
    expect(effect?.attempt_ids).toEqual([AttemptId('act:patch:1:1'), AttemptId('act:patch:1:reconcile:1')])
    expect(effect?.receipt).toMatchObject({ reconciled: true })
    await verify.fiber.dispose()
  })

  it('a reconcile probe does NOT re-apply the IRREVERSIBLE mutation (external state unchanged by the reconciler)', async () => {
    const path = await freshDbPath('dsh-a5-noreapply-')
    const sessionId = SessionId('a5-noreapply')
    const external = { db: new Map<string, string>(), loseResponse: false, rawCalls: 0 }
    const { ctx, runtime } = await boot(path, sessionId)
    const kernel = new CapabilityKernel()
    kernel.grant({
      id: 'cap-patch',
      principal: 'model-session-1',
      operation: 'fs.patch',
      resourceScope: 'fs:/srv/app/**',
      effectClasses: ['IRREVERSIBLE'],
    })
    const executor = new EffectExecutor({
      runtime,
      kernel,
      workers: new Map([['fs.patch', makeIrreversibleWorker(external)]]),
    })
    external.loseResponse = true
    await executor.execute(patchProposal())
    await ctx.fiber.dispose()

    // The child's fake external starts empty (mutation truly lost). The
    // reconciler must NOT re-apply — it observes nothing committed and reports
    // failed, leaving the action unambiguous-but-not-committed.
    const child = childReconcile(path, String(sessionId), 'act:patch:1', 'fs:/srv/app/seed.json')
    expect(child.BEFORE_OUTCOME).toBe('commit-unknown')
    expect(child.RECONCILE_RESULT).toBe('failed')
    expect(child.AFTER_OUTCOME).toBe('failed')
    // The child never re-applied the mutation.
    const verify = new Context()
    await verify.plugin(SessionStore)
    await verify.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    const verifyRuntime = new ExecutionRuntime({
      persistence: verify.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: `verify-${process.pid}`, ownership_epoch: 0 },
    })
    const derived = await verifyRuntime.derive()
    const effect = derived.effects.get(ActionId('act:patch:1'))
    expect(effect?.outcome).toBe('failed')
    expect(effect?.attempt_ids).toEqual([AttemptId('act:patch:1:1'), AttemptId('act:patch:1:reconcile:1')])
    await verify.fiber.dispose()
  })

  it('the ambiguous action id stays stable and no second EffectAuthorized is appended on reconcile', async () => {
    const path = await freshDbPath('dsh-a5-stable-')
    const sessionId = SessionId('a5-stable')
    const external = { db: new Map<string, string>(), loseResponse: false, rawCalls: 0 }
    const { ctx, runtime } = await boot(path, sessionId)
    const kernel = new CapabilityKernel()
    kernel.grant({
      id: 'cap-patch',
      principal: 'model-session-1',
      operation: 'fs.patch',
      resourceScope: 'fs:/srv/app/**',
      effectClasses: ['IRREVERSIBLE'],
    })
    const executor = new EffectExecutor({
      runtime,
      kernel,
      workers: new Map([['fs.patch', makeIrreversibleWorker(external)]]),
    })
    external.loseResponse = true
    await executor.execute(patchProposal({ action_id: 'act:stable:1', resource: 'fs:/srv/app/x.json' }))
    await ctx.fiber.dispose()

    const child = childReconcile(path, String(sessionId), 'act:stable:1', 'fs:/srv/app/x.json', external.db)
    expect(child.AFTER_OUTCOME).toBe('reconciled')

    // One canonical effect/authorized only — reconcile re-authorizes nothing.
    const verify = new Context()
    await verify.plugin(SessionStore)
    await verify.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    const loaded = await verify.sessionPersistence.load(sessionId)
    const authorized = loaded.events.filter(e => e.type === 'effect/authorized' && (e.data as { action_id: string }).action_id === 'act:stable:1')
    expect(authorized.length).toBe(1)
    const reconciled = loaded.events.filter(e => e.type === 'effect/reconciled' && (e.data as { action_id: string }).action_id === 'act:stable:1')
    expect(reconciled.length).toBe(1)
    expect((reconciled[0]?.data as { attempt_id: string }).attempt_id).toBe('act:stable:1:reconcile:1')
    await verify.fiber.dispose()
  })
})
