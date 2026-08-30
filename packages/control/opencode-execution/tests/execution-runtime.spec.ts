/**
 * Execution runtime proofs on real DSH backing: fenced canonical appends,
 * epoch CAS migration, stale-writer rejection, and full effect lifecycle
 * persistence + fresh-runtime re-derivation.
 * @module @deepseek-ai/dsh-opencode-execution/tests/execution-runtime
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, {
  type SqliteSessionPersistence,
  SessionOwnershipFencedError as BackendOwnershipFencedError,
} from '@deepseek-ai/dsh-session-persistence-sqlite'
import { ActionId, AttemptId, ExecutionId } from '@deepseek-ai/dsh-opencode-control'
import { ExecutionRuntime, SessionOwnershipFencedError } from '../src/execution-runtime.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

/** Boot a real Context with SessionStore + SQLite persistence for one session. */
async function bootSession(path: string, sessionId: SessionId, cwd = '/workspace'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
  await ctx.sessionPersistence.create({ version: 0, id: sessionId, createdAt: 1_000, cwd })
  return ctx
}

describe('ExecutionRuntime on real DSH backing', () => {
  it('appends a real execution/commanded to the DSH log (reload and assert)', async () => {
    const path = await freshDbPath('dsh-rt-command-')
    const sessionId = SessionId('rt-command')
    const ctx = await bootSession(path, sessionId)
    const runtime = new ExecutionRuntime({
      persistence: ctx.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'worker-1', ownership_epoch: 0 },
    })
    await runtime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface')
    await ctx.fiber.dispose()

    // Fresh context over the same file: the control event is durably present.
    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SessionPersistenceSqlite, { path })
    const loaded = await fresh.sessionPersistence.load(sessionId)
    expect(loaded.events.map(event => event.type)).toContain('execution/commanded')
    const commanded = loaded.events.find(event => event.type === 'execution/commanded')
    expect(commanded?.data).toMatchObject({ version: 1, execution_id: 'exec-1', command: 'git status', source: 'surface' })
    await fresh.fiber.dispose()
  })

  it('migrates ownership via CAS; a stale writer is fenced and cannot write', async () => {
    const path = await freshDbPath('dsh-rt-migrate-')
    const sessionId = SessionId('rt-migrate')
    const ctx = await bootSession(path, sessionId)
    const runtime = new ExecutionRuntime({
      persistence: ctx.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'worker-1', ownership_epoch: 0 },
    })
    await runtime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface')

    // CAS 0→1 wins.
    await runtime.migrateOwnership(0, 1, 'worker-2')
    expect(runtime.writer).toEqual({ worker_id: 'worker-2', ownership_epoch: 1 })

    // The stale writer (epoch 0) is fenced on its next append.
    const stale = new ExecutionRuntime({
      persistence: ctx.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'worker-1', ownership_epoch: 0 },
    })
    await expect(stale.beginExecution(ExecutionId('exec-2'), 'ls', 'surface'))
      .rejects.toBeInstanceOf(BackendOwnershipFencedError)
    await ctx.fiber.dispose()

    // Only the migrated writer's append landed.
    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SessionPersistenceSqlite, { path })
    const loaded = await fresh.sessionPersistence.load(sessionId)
    expect(loaded.events).toHaveLength(1)
    await fresh.fiber.dispose()
  })

  it('rejects a stale-epoch append outright (fenced)', async () => {
    const path = await freshDbPath('dsh-rt-stale-')
    const sessionId = SessionId('rt-stale')
    const ctx = await bootSession(path, sessionId)
    // Materialize the session with a first append so the epoch row exists.
    const first = new ExecutionRuntime({
      persistence: ctx.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'worker-1', ownership_epoch: 0 },
    })
    await first.beginExecution(ExecutionId('exec-0'), 'init', 'surface')
    // Advance the epoch out-of-band so the runtime's token is stale.
    await (ctx.sessionPersistence as SqliteSessionPersistence).advanceOwnershipEpoch(sessionId, 0, 2)
    const runtime = new ExecutionRuntime({
      persistence: ctx.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'worker-1', ownership_epoch: 0 },
    })
    await expect(runtime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface'))
      .rejects.toBeInstanceOf(BackendOwnershipFencedError)
    await ctx.fiber.dispose()
  })

  it('persists a full effect lifecycle canonically; a fresh runtime re-derives the same effect state', async () => {
    const path = await freshDbPath('dsh-rt-lifecycle-')
    const sessionId = SessionId('rt-lifecycle')
    const ctx = await bootSession(path, sessionId)
    const runtime = new ExecutionRuntime({
      persistence: ctx.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'worker-1', ownership_epoch: 0 },
    })
    const execution = ExecutionId('exec-1')
    const action = ActionId('act-1')
    const attempt = AttemptId('attempt-1')
    await runtime.beginExecution(execution, 'apply patch', 'surface')
    await runtime.requestEffect(execution, action, 'write', '/workspace/patch.diff', 'filesystem')
    await runtime.authorizeEffect(execution, action, 'fs.write')
    await runtime.startAttempt(execution, action, attempt)
    await runtime.succeedEffect(execution, action, attempt, { ok: true })
    await ctx.fiber.dispose()

    // Fresh runtime over the same file derives the same effect state.
    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SessionPersistenceSqlite, { path })
    const freshRuntime = new ExecutionRuntime({
      persistence: fresh.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'worker-2', ownership_epoch: 0 },
    })
    const derived = await freshRuntime.derive()
    expect(derived.effects.get(action)?.outcome).toBe('succeeded')
    expect(derived.effects.get(action)?.capability_id).toBe('fs.write')
    expect(derived.effects.get(action)?.attempt_ids).toEqual([attempt])
    expect(derived.effects.get(action)?.receipt).toEqual({ ok: true })
    await fresh.fiber.dispose()
  })

  it('rejects out-of-order control transitions with the P0–P3 error strings', async () => {
    const path = await freshDbPath('dsh-rt-order-')
    const sessionId = SessionId('rt-order')
    const ctx = await bootSession(path, sessionId)
    const runtime = new ExecutionRuntime({
      persistence: ctx.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'worker-1', ownership_epoch: 0 },
    })
    const execution = ExecutionId('exec-1')
    const action = ActionId('act-1')
    const attempt = AttemptId('attempt-1')

    // Activity correlation without a commanded execution.
    await expect(runtime.correlateActivity(execution, 1, 'shell.stdout'))
      .rejects.toThrow(/activity correlation without commanded execution/)

    // Effect result without prior authorization.
    await runtime.beginExecution(execution, 'x', 'surface')
    await expect(runtime.succeedEffect(execution, action, attempt, { ok: true }))
      .rejects.toThrow(/effect result without prior attempt/)

    // Attempt start without authorization.
    await expect(runtime.startAttempt(execution, action, attempt))
      .rejects.toThrow(/effect attempt without authorization/)

    // Reconciliation of an action that is not commit-unknown.
    await runtime.requestEffect(execution, action, 'write', '/workspace/a', 'filesystem')
    await runtime.authorizeEffect(execution, action, 'fs.write')
    await runtime.startAttempt(execution, action, attempt)
    await runtime.succeedEffect(execution, action, attempt, { ok: true })
    await expect(runtime.reconcileEffect(execution, action, AttemptId('act-1:reconcile:1'), { ok: true }))
      .rejects.toThrow(/only an ambiguous \(commit-unknown\) action can be reconciled/)

    // Migration CAS that lost (epoch already advanced) is fenced.
    await runtime.migrateOwnership(0, 1, 'worker-2')
    await expect(runtime.migrateOwnership(0, 2, 'worker-3'))
      .rejects.toBeInstanceOf(SessionOwnershipFencedError)
    expect(runtime.writer).toEqual({ worker_id: 'worker-2', ownership_epoch: 1 })
    await ctx.fiber.dispose()
  })

  it('exposes ownershipEpochOf/advanceOwnershipEpoch through the public service', async () => {
    const path = await freshDbPath('dsh-rt-public-')
    const sessionId = SessionId('rt-public')
    const ctx = await bootSession(path, sessionId)
    // A freshly created session is lazily materialized: the epoch row appears
    // only after the first append. Append first, then the epoch is 0.
    const runtime = new ExecutionRuntime({
      persistence: ctx.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'worker-1', ownership_epoch: 0 },
    })
    await runtime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface')
    expect(await (ctx.sessionPersistence as SqliteSessionPersistence).ownershipEpochOf(sessionId)).toBe(0)
    expect(await (ctx.sessionPersistence as SqliteSessionPersistence).advanceOwnershipEpoch(sessionId, 0, 3)).toBe(true)
    expect(await (ctx.sessionPersistence as SqliteSessionPersistence).advanceOwnershipEpoch(sessionId, 0, 3)).toBe(false)
    expect(await (ctx.sessionPersistence as SqliteSessionPersistence).ownershipEpochOf(sessionId)).toBe(3)
    await ctx.fiber.dispose()
  })
})
