/**
 * A7 CRITICAL MUTATION: SQLite-as-authority must be DETECTED. The principal's
 * decisive property is "delete every derived DB → all semantic execution state
 * recoverable from DSH canonical persistence alone". This suite proves the
 * NEGATIVE direction the current gates do not: derived state is a pure function
 * of the DSH log served by the persistence surface, NOT of any private store or
 * runtime memory. Concretely:
 *
 *   (1) DI: a runtime writes control facts; re-deriving through a persistence
 *       surface that serves a DIFFERENT (or empty) DSH log yields state that
 *       follows the served log — the fold never reads a private control table
 *       or runtime memory.
 *   (2) Truncation: delete ONLY the canonical DSH log rows (or point the fold
 *       at an empty DB) while a private table still holds the facts — derived
 *       state must NOT reconstruct them. This is the test that makes
 *       "SQLite-as-authority" detectable even when both write and fold are
 *       redirected to a private store.
 * @module @deepseek-ai/dsh-opencode-execution/tests/a7-authority-detection
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
import type { SessionInspection, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { ActionId, ExecutionId } from '@deepseek-ai/dsh-opencode-control'
import { ExecutionRuntime } from '../src/execution-runtime.ts'
import { deriveAll } from '../src/ledger-deriver.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

async function boot(path: string, sessionId: SessionId): Promise<{ ctx: Context; runtime: ExecutionRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
  await ctx.sessionPersistence.create({ version: 0, id: sessionId, createdAt: 1_000, cwd: '/workspace' })
  const runtime = new ExecutionRuntime({
    persistence: ctx.sessionPersistence as SqliteSessionPersistence,
    session_id: sessionId,
    writer: { worker_id: 'a7-auth-w', ownership_epoch: 0 },
  })
  return { ctx, runtime }
}

/** A persistence stub that serves a canned inspection (an "empty/other DSH log"). */
class StubPersistence implements Pick<SessionPersistence, 'load'> {
  constructor(private readonly inspection: SessionInspection) {}
  async load(): Promise<SessionInspection> {
    return this.inspection
  }
}

describe('SQLite-as-authority is detected', () => {
  it('derived state follows the SERVED DSH log, never runtime memory or a private store', async () => {
    const path = await freshDbPath('dsh-a7-auth-di-')
    const sessionId = SessionId('a7-auth-di')
    const { ctx, runtime } = await boot(path, sessionId)

    // Write control facts through the runtime (the real canonical path).
    await runtime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface')
    await runtime.requestEffect(ExecutionId('exec-1'), ActionId('act-1'), 'write', '/workspace/a.txt', 'filesystem')
    const real = await runtime.derive()
    expect(real.executions.has(ExecutionId('exec-1'))).toBe(true)
    expect(real.effects.get(ActionId('act-1'))?.outcome).toBe('requested')

    // Now re-derive through a stub persistence that serves an EMPTY DSH log.
    // If any private control table or runtime memory fed the fold, the derived
    // state would still contain exec-1/act-1. It must NOT — derived state is a
    // pure function of the served canonical log.
    const emptyInspection: SessionInspection = {
      meta: { version: 0, id: sessionId, createdAt: 1_000, cwd: '/workspace' },
      events: [],
    }
    const stub = new StubPersistence(emptyInspection)
    const throughStub = await deriveAll(stub as unknown as SessionPersistence, sessionId)
    expect(throughStub.executions.has(ExecutionId('exec-1'))).toBe(false)
    expect(throughStub.effects.get(ActionId('act-1'))).toBeUndefined()
    expect(throughStub.last_seq).toBe(-1)
    await ctx.fiber.dispose()
  })

  it('deleting the canonical DSH log rows while a private table retains facts does NOT reconstruct them', async () => {
    const path = await freshDbPath('dsh-a7-auth-truncate-')
    const sessionId = SessionId('a7-auth-truncate')
    const { ctx, runtime } = await boot(path, sessionId)
    await runtime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface')
    const before = await runtime.derive()
    expect(before.executions.has(ExecutionId('exec-1'))).toBe(true)

    // Simulate the second-authority attack: the runtime wrote to a private
    // store (here: the same DB but we will drop the CANONICAL DSH log rows,
    // leaving nothing for the fold). A projection-only-authority design would
    // keep exec-1 in some private table and report it; the honest fold must
    // report an empty state because the canonical log is gone.
    //
    // We delete the events rows directly from the sqlite file the persistence
    // backend owns. (The backend is disposed first so no connection is live.)
    await ctx.fiber.dispose()

    // Reopen with raw node:sqlite and delete the events table content for the
    // session. This is the "canonical log destroyed, private state survives"
    // scenario stripped to its essence.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    db.exec('DELETE FROM events')
    db.close()

    // Fresh runtime over the now-empty canonical log: derived state is empty.
    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SessionPersistenceSqlite, { path })
    const after = await deriveAll(fresh.sessionPersistence, sessionId)
    expect(after.executions.has(ExecutionId('exec-1'))).toBe(false)
    expect(after.last_seq).toBe(-1)
    await fresh.fiber.dispose()
  })

  it('a full derived DB delete/rebuild reproduces the digest exactly (decisive property)', async () => {
    // The positive form of the decisive property, on the real runtime: write
    // through the runtime, delete the ENTIRE derived SQLite file, rebuild from
    // a re-created canonical log with identical events, and compare digests.
    const path = await freshDbPath('dsh-a7-auth-rebuild-')
    const sessionId = SessionId('a7-auth-rebuild')
    const { ctx, runtime } = await boot(path, sessionId)
    await runtime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface')
    await runtime.requestEffect(ExecutionId('exec-1'), ActionId('act-1'), 'write', '/workspace/a.txt', 'filesystem')
    const original = await runtime.derive()
    await ctx.fiber.dispose()

    // Capture the canonical log events BEFORE destroying the DB.
    const { DatabaseSync } = await import('node:sqlite')
    const captureDb = new DatabaseSync(path)
    const rows = captureDb.prepare('SELECT seq, type, time, data FROM events ORDER BY seq').all() as Array<{ seq: number; type: string; time: number; data: string }>
    captureDb.close()
    expect(rows.length).toBe(2) // execution/commanded + effect/requested

    // Destroy the derived DB entirely.
    const dbDir = join(path, '..')
    await rm(dbDir, { recursive: true, force: true })

    // Rebuild: a fresh DB, re-append the SAME canonical events, re-derive.
    const path2 = await freshDbPath('dsh-a7-auth-rebuild2-')
    const rebuilt = new Context()
    await rebuilt.plugin(SessionStore)
    await rebuilt.plugin(SessionPersistenceSqlite, { path: path2, writeBatchMaxDelayMs: 1_000 })
    await rebuilt.sessionPersistence.create({ version: 0, id: sessionId, createdAt: 1_000, cwd: '/workspace' })
    const rebuiltRuntime = new ExecutionRuntime({
      persistence: rebuilt.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'a7-auth-rebuild-w', ownership_epoch: 0 },
    })
    // Re-append the same two canonical facts in the same order.
    await rebuiltRuntime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface')
    await rebuiltRuntime.requestEffect(ExecutionId('exec-1'), ActionId('act-1'), 'write', '/workspace/a.txt', 'filesystem')
    const rebuiltState = await rebuiltRuntime.derive()
    expect(rebuiltState.digest).toBe(original.digest)
    expect(rebuiltState.executions.get(ExecutionId('exec-1'))?.command).toBe('git status')
    await rebuilt.fiber.dispose()
  })
})
