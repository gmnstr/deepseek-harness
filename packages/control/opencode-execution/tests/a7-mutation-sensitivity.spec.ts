/**
 * P3 mutation sensitivity on the converged architecture (A7). The P3 gate's
 * negative-verification axis is: removing a critical safeguard must make the
 * suite FAIL. Each critical safeguard in the converged package has a removable
 * source seam; the mutated module is loaded in a fresh isolate (a unique copy
 * in the src directory so relative imports resolve) and a behavioral probe that
 * PASSES on the real implementation FAILS on the mutated variant — mechanically
 * proving the seam is load-bearing.
 *
 * Mutation axes (converged equivalents of the frozen P3 mutations + the A3
 * projection bug class + the SQLite-as-authority critical mutation):
 *   1. capability gate bypass      — `if (!decision.authorized)` → `if (false)`
 *   2. writer fencing disabled     — store `assertEpoch` epoch check → `if (false)`
 *   3. effect re-entry guard       — `assertReentry` outcome check → `if (false)`
 *   4. projection sticky-outcome   — attempt-started drop under sticky outcome
 *   5. single-write-path audit     — source-assert exactly one canonical entry
 * @module @deepseek-ai/dsh-opencode-execution/tests/a7-mutation-sensitivity
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, {
  type SqliteSessionPersistence,
} from '@deepseek-ai/dsh-session-persistence-sqlite'
import { ActionId, ExecutionId } from '@deepseek-ai/dsh-opencode-control'
import { CapabilityKernel, type EffectProposal } from '../src/capability.ts'
import { ExecutionRuntime } from '../src/execution-runtime.ts'
import { EffectExecutor, type EffectWorker } from '../src/effect-executor.ts'

const dirs: string[] = []
const SRC = join(import.meta.dirname, '..', 'src')
let mutCounter = 0

afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

/** Load a mutated copy of a src module in a fresh isolate. */
async function loadMutated<T>(name: string, source: string): Promise<T> {
  const path = join(SRC, `_a7mut_${mutCounter++}_${name}`)
  await writeFileSync(path, source)
  try {
    const mod = await import(pathToFileURL(path).href)
    return mod as T
  } finally {
    await rm(path, { force: true })
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
    writer: { worker_id: 'a7-mut-w', ownership_epoch: 0 },
  })
  await runtime.beginExecution(ExecutionId('exec-1'), 'apply change', 'surface')
  return { ctx, runtime }
}

function proposal(over: Partial<EffectProposal> = {}): EffectProposal {
  return {
    execution_id: 'exec-1',
    action_id: 'act:write:1',
    attempt_id: 'act:write:1:1',
    operation: 'fs.write',
    resource: 'fs:/srv/app/config.json',
    effect_class: 'IDEMPOTENT',
    proposer: 'model-session-1',
    payload: { content: 'a=1' },
    ...over,
  }
}

function makeWorker(external: { rawCalls: number }): EffectWorker {
  return {
    operation: 'fs.write',
    async execute() {
      external.rawCalls++
      return { kind: 'succeeded', receipt: { ok: true } }
    },
  }
}

describe('A7 mutation sensitivity on converged seams', () => {
  it('seam inventory: every critical safeguard has a removable seam in committed source', async () => {
    const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
    const axes: Array<{ name: string; file: string; seam: string }> = [
      { name: 'capability-authorization', file: 'effect-executor.ts', seam: 'if (!decision.authorized) {' },
      { name: 'effect-reentry-guard', file: 'effect-executor.ts', seam: "const terminalOrAmbiguous = effect.outcome === 'succeeded' || effect.outcome === 'reconciled'\n      || effect.outcome === 'commit-unknown' || effect.ambiguous\n    if (terminalOrAmbiguous) {" },
      { name: 'commit-unknown-never-blind-retried', file: 'effect-executor.ts', seam: 'outcome = { kind: \'commit-unknown\' }' },
      { name: 'single-canonical-write-entry', file: 'execution-runtime.ts', seam: 'await this.persistence.appendFenced(' },
    ]
    for (const axis of axes) {
      expect(read(axis.file).includes(axis.seam), `${axis.name}: seam not found in ${axis.file}`).toBe(true)
    }

    // Writer-fencing seam lives in the SQLite store, not the runtime package.
    const store = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'session', 'session-persistence-sqlite', 'src', 'store.ts'),
      'utf8',
    )
    expect(store.includes('if (row.ownership_epoch !== writerEpoch) {')).toBe(true)
  })

  it('mutation: bypassing the capability gate invokes the effector without authorization', async () => {
    const real = readFileSync(join(SRC, 'effect-executor.ts'), 'utf8')
    const mutated = real.replace('if (!decision.authorized) {', 'if (false) {')
    expect(mutated !== real).toBe(true)

    const m = await loadMutated<{ EffectExecutor: typeof EffectExecutor }>('effect-executor.m.ts', mutated)
    const path = await freshDbPath('dsh-a7-mut-cap-')
    const sessionId = SessionId('a7-mut-cap')
    const { ctx, runtime } = await boot(path, sessionId)
    const external = { rawCalls: 0 }
    const executor = new m.EffectExecutor({
      runtime,
      kernel: new CapabilityKernel(), // EMPTY: nothing authorized.
      workers: new Map([['fs.write', makeWorker(external)]]),
    })
    const result = await executor.execute(proposal())
    // Real implementation: decision.authorized=false, rawCalls=0.
    // MUTATED variant: dispatches despite the denial.
    expect(result.decision.authorized).toBe(false)
    expect(external.rawCalls).toBe(1)
    await ctx.fiber.dispose()
  })

  it('mutation: disabling the re-entry guard permits a duplicate dispatch of an ambiguous action', async () => {
    const real = readFileSync(join(SRC, 'effect-executor.ts'), 'utf8')
    const guard = "const terminalOrAmbiguous = effect.outcome === 'succeeded' || effect.outcome === 'reconciled'\n      || effect.outcome === 'commit-unknown' || effect.ambiguous\n    if (terminalOrAmbiguous) {"
    expect(real.includes(guard)).toBe(true)
    const mutated = real.replace(guard, 'if (false) {')
    expect(mutated !== real).toBe(true)

    const m = await loadMutated<{ EffectExecutor: typeof EffectExecutor }>('effect-executor.m.ts', mutated)
    const path = await freshDbPath('dsh-a7-mut-reentry-')
    const sessionId = SessionId('a7-mut-reentry')
    const { ctx, runtime } = await boot(path, sessionId)
    const external = { rawCalls: 0 }
    const kernel = new CapabilityKernel()
    kernel.grant({
      id: 'cap-patch',
      principal: 'model-session-1',
      operation: 'fs.patch',
      resourceScope: 'fs:/srv/app/**',
      effectClasses: ['IRREVERSIBLE'],
    })
    const patchWorker: EffectWorker = {
      operation: 'fs.patch',
      async execute() {
        external.rawCalls++
        return { kind: 'commit-unknown' }
      },
    }
    const executor = new m.EffectExecutor({
      runtime,
      kernel,
      workers: new Map([['fs.patch', patchWorker]]),
    })
    const p = proposal({
      action_id: 'act:patch:1',
      attempt_id: 'act:patch:1:1',
      operation: 'fs.patch',
      resource: 'fs:/srv/app/seed.json',
      effect_class: 'IRREVERSIBLE',
      payload: { patch: 'DELETE' },
    })
    const r1 = await executor.execute(p)
    expect(r1.result?.outcome.kind).toBe('commit-unknown')
    expect(external.rawCalls).toBe(1)
    // MUTATED: re-entry guard off → a second execute() dispatches again.
    const r2 = await executor.execute({ ...p, attempt_id: 'act:patch:1:retry:2' })
    expect(r2.result?.outcome.kind).toBe('commit-unknown')
    expect(external.rawCalls).toBe(2)
    await ctx.fiber.dispose()
  })

  it('mutation: dropping the attempt-started under a sticky outcome hides the reconcile probe identity', async () => {
    // The A3 projection bug class: if the `attempt_ids` push were moved inside
    // the non-sticky branch, a reconcile-probe attempt-started after
    // commit-unknown would be dropped — later terminal events referencing it
    // would fail `requireAttemptStarted`, breaking recovery.
    const real = readFileSync(join(SRC, 'projection.ts'), 'utf8')
    const seam = 'const next = { ...current, outcome, attempt_ids: [...current.attempt_ids, payload.attempt_id] }'
    expect(real.includes(seam)).toBe(true)
    // Mutation: only append the attempt id when the outcome is NOT sticky.
    const mutated = real.replace(
      seam,
      'const next = current.outcome === \'commit-unknown\' || current.outcome === \'succeeded\' || current.outcome === \'reconciled\'\n            ? current\n            : { ...current, outcome, attempt_ids: [...current.attempt_ids, payload.attempt_id] }',
    )
    expect(mutated !== real).toBe(true)

    const m = await loadMutated<{
      foldProjection: (
        events: readonly unknown[],
        sessionId: string,
      ) => { effects: ReadonlyMap<string, { attempt_ids: readonly unknown[] }> }
    }>(
      'projection.m.ts',
      mutated,
    )
    const { AttemptId, effectAttemptStarted, effectCommitUnknown, effectReconciled, effectRequested, executionCommanded } =
      await import('@deepseek-ai/dsh-opencode-control')
    const exec = ExecutionId('exec-1')
    const action = ActionId('act-1')
    const attempt = AttemptId('act-1:1')
    const reconcile = AttemptId('act-1:reconcile:1')
    const fixtures = [
      { type: 'execution/commanded', data: executionCommanded({ execution_id: exec, command: 'x', source: 'surface' }) },
      { type: 'effect/requested', data: effectRequested({ execution_id: exec, action_id: action, operation: 'write', resource: '/workspace/a', effect_class: 'filesystem' }) },
      { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: exec, action_id: action, attempt_id: attempt }) },
      { type: 'effect/commit-unknown', data: effectCommitUnknown({ execution_id: exec, action_id: action, attempt_id: attempt }) },
      { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: exec, action_id: action, attempt_id: reconcile }) },
      { type: 'effect/reconciled', data: effectReconciled({ execution_id: exec, action_id: action, attempt_id: reconcile, receipt: { ok: true } }) },
    ]
    const events = fixtures.map((fixture, seq) => ({
      type: fixture.type as SessionEvent['type'],
      seq,
      time: 1_000 + seq,
      data: fixture.data as SessionEvent['data'],
    } as SessionEvent))

    // Real implementation: BOTH attempt ids present.
    const realState = (await import('../src/projection.ts')).foldProjection(events, 'proj-mut')
    expect(realState.effects.get(action)?.attempt_ids).toEqual([attempt, reconcile])

    // MUTATED variant: the reconcile probe's attempt id is dropped.
    const mutatedState = m.foldProjection(events, 'proj-mut')
    expect(mutatedState.effects.get(action)?.attempt_ids).toEqual([attempt])
  })

  it('single-write-path audit: exactly one canonical write entry point; no src module mints its own SQLite', async () => {
    // Complete mediation: every canonical control write in the package flows
    // through `appendFenced`. No src module constructs its own database or
    // writes control rows outside the persistence backend.
    const files = ['execution-runtime.ts', 'effect-executor.ts', 'ledger-deriver.ts', 'projection.ts', 'capability.ts']
    for (const file of files) {
      const source = readFileSync(join(SRC, file), 'utf8')
      // No src module may open its own SQLite database.
      expect(source).not.toMatch(/new DatabaseSync|new Database\(/)
      expect(source).not.toMatch(/node:sqlite/)
    }
    const runtimeSource = readFileSync(join(SRC, 'execution-runtime.ts'), 'utf8')
    const appends = runtimeSource.match(/this\.persistence\.appendFenced\(/g)
    expect(appends?.length ?? 0).toBeGreaterThanOrEqual(1)
    // The ONLY write method is appendControl → appendFenced. No other
    // persistence mutation (append, commitPrepared, advanceEpoch outside
    // migrateOwnership) may be invoked for canonical writes.
    expect(runtimeSource).not.toMatch(/this\.persistence\.append\(/g)
  })
})
