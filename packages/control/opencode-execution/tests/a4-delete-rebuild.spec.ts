/**
 * A4 hard delete/rebuild gate with REAL DSH persistence across a process
 * boundary. The derived projection (foldProjection) is a pure function of the
 * canonical DSH log; deleting every derived artifact and rebuilding in a fresh
 * process from the persisted DSH state alone must reproduce an identical
 * derived-state digest — zero facts lost.
 *
 * Two phases:
 * 1. Write a representative history (native + control) in-process, derive a
 *    digest, then spawn a REAL child `node --import tsx/esm` process that
 *    opens the SAME DSH sqlite file, deletes/ignores any derived state, and
 *    re-derives. Digests must match.
 * 2. The child re-derives WITHOUT any derived projection ever existing —
 *    identical digest.
 * @module @deepseek-ai/dsh-opencode-execution/tests/a4-delete-rebuild
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import {
  ActionId,
  AttemptId,
  ExecutionId,
  activityCorrelated,
  effectAttemptStarted,
  effectAuthorized,
  effectCommitUnknown,
  effectFailed,
  effectReconciled,
  effectRequested,
  executionCommanded,
} from '@deepseek-ai/dsh-opencode-control'
import { deriveAll } from '../src/index.ts'

const EXECUTION = ExecutionId('exec-1')
const ACTION = ActionId('act-1')
const ATTEMPT = AttemptId('attempt-1')

/**
 * A representative canonical history for the delete/rebuild gate: two
 * executions, an activity correlation, an authorized-then-failed effect, and
 * an ambiguous effect resolved via reconcile. Deterministic times/seqs.
 */
function representativeHistory(): SessionEvent[] {
  const fixtures: Array<{ type: string; data: Record<string, unknown> }> = [
    { type: 'execution/commanded', data: executionCommanded({ execution_id: EXECUTION, command: 'deploy', source: 'surface' }) },
    { type: 'activity/correlated', data: activityCorrelated({ execution_id: EXECUTION, native_event_seq: 1, kind: 'shell.stdout' }) },
    { type: 'effect/requested', data: effectRequested({ execution_id: EXECUTION, action_id: ACTION, operation: 'write', resource: '/srv/app', effect_class: 'filesystem' }) },
    { type: 'effect/authorized', data: effectAuthorized({ execution_id: EXECUTION, action_id: ACTION, capability_id: 'fs.write' }) },
    { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT }) },
    { type: 'effect/failed', data: effectFailed({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT, error: 'EACCES' }) },
    { type: 'effect/requested', data: effectRequested({ execution_id: EXECUTION, action_id: ActionId('act-2'), operation: 'patch', resource: '/srv/config.json', effect_class: 'filesystem' }) },
    { type: 'effect/authorized', data: effectAuthorized({ execution_id: EXECUTION, action_id: ActionId('act-2'), capability_id: 'fs.patch' }) },
    { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: EXECUTION, action_id: ActionId('act-2'), attempt_id: AttemptId('act-2:1') }) },
    { type: 'effect/commit-unknown', data: effectCommitUnknown({ execution_id: EXECUTION, action_id: ActionId('act-2'), attempt_id: AttemptId('act-2:1') }) },
    { type: 'effect/reconciled', data: effectReconciled({ execution_id: EXECUTION, action_id: ActionId('act-2'), attempt_id: AttemptId('act-2:reconcile:1'), receipt: { reconciled: true } }) },
    { type: 'execution/commanded', data: executionCommanded({ execution_id: ExecutionId('exec-2'), command: 'verify', source: 'hook' }) },
  ]
  return fixtures.map((fixture, seq) => ({
    type: fixture.type as SessionEvent['type'],
    seq,
    time: 2_000 + seq,
    data: fixture.data as SessionEvent['data'],
  } as SessionEvent))
}

/**
 * The committed child-process derivation entry. Spawned with
 * `node --import tsx/esm` by `childDigest`. It opens ONLY the DSH sqlite DB
 * (no derived projection on disk) and derives the read model from the
 * canonical log, printing the digest. A genuine process boundary: the
 * parent's in-memory runtime is gone.
 */
const CHILD_SRC_PATH = join(import.meta.dirname, 'fixtures', 'a4-child.mjs')

/** Spawn a real child node process that derives the digest from the DSH DB. */
function childDigest(dbPath: string, sessionId: string, tag: string): string {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx/esm', CHILD_SRC_PATH, dbPath, sessionId, tag],
    { encoding: 'utf8', cwd: fileURLToPath(new URL('../../..', import.meta.url)) },
  )
  const line = output.split('\n').find(l => l.startsWith('DIGEST='))
  if (!line) throw new Error(`child produced no DIGEST: ${output}`)
  return line.slice('DIGEST='.length)
}

describe('A4 hard delete/rebuild gate (real DSH persistence, process boundary)', () => {
  it('re-derives an identical digest in a fresh process from the persisted DSH log alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-a4-'))
    const dbPath = join(dir, 'sessions.db')
    const sessionId = SessionId('a4-process-boundary')
    try {
      // Phase 1: write the representative history to real DSH persistence.
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
      const session = ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
      for (const event of representativeHistory()) {
        session.append(event.type, event.data as never)
      }
      await ctx.sessions.flush(session)
      await ctx.fiber.dispose() // terminate the writer process

      // Phase 2: derive in-process (the "first projection materialization").
      const first = new Context()
      await first.plugin(SessionStore)
      await first.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
      const inProc = await deriveAll(first.sessionPersistence, sessionId)
      const digest1 = inProc.digest
      expect(inProc.executions.size).toBe(2)
      expect(inProc.effects.size).toBe(2)
      expect(inProc.activities.length).toBe(1)
      await first.fiber.dispose()

      // Phase 3: delete the derived projection entirely (nothing persisted),
      // spawn a REAL child process that opens ONLY the DSH sqlite DB and
      // re-derives from the canonical log. The child has no in-memory history
      // and no derived projection.
      const digest2 = childDigest(dbPath, String(sessionId), 'rebuild')
      expect(digest2).toBe(digest1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('produces the identical digest when no derived projection ever existed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-a4-fresh-'))
    const dbPath = join(dir, 'sessions.db')
    const sessionId = SessionId('a4-no-projection')
    try {
      // Write the history but NEVER materialize any projection (no fold).
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
      const session = ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
      for (const event of representativeHistory()) {
        session.append(event.type, event.data as never)
      }
      await ctx.sessions.flush(session)
      await ctx.fiber.dispose()

      // Child derives with no projection ever having existed.
      const digestFresh = childDigest(dbPath, String(sessionId), 'fresh')

      // A separate child re-deriving again (and a third time) must agree.
      const digestAgain = childDigest(dbPath, String(sessionId), 'again')
      expect(digestAgain).toBe(digestFresh)

      // And an in-process fold of the persisted log agrees too.
      const verify = new Context()
      await verify.plugin(SessionStore)
      await verify.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
      const state = await deriveAll(verify.sessionPersistence, sessionId)
      expect(state.digest).toBe(digestFresh)
      await verify.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('continues a session safely after delete/rebuild (append after rebuild)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-a4-continue-'))
    const dbPath = join(dir, 'sessions.db')
    const sessionId = SessionId('a4-continue')
    try {
      // Write, dispose, child-derive digest.
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
      const session = ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
      for (const event of representativeHistory()) {
        session.append(event.type, event.data as never)
      }
      await ctx.sessions.flush(session)
      await ctx.fiber.dispose()
      const digestBefore = childDigest(dbPath, String(sessionId), 'continue-before')

      // A fresh process resumes: loads the canonical log, rebuilds, and
      // continues by appending a new canonical control fact through the
      // fenced persistence service (the runtime's only write path).
      const resumed = new Context()
      await resumed.plugin(SessionStore)
      await resumed.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
      const rebuilt = await deriveAll(resumed.sessionPersistence, sessionId)
      expect(rebuilt.digest).toBe(digestBefore)
      const loaded = await resumed.sessionPersistence.load(sessionId)
      const nextSeq = loaded.events[loaded.events.length - 1]?.seq ?? -1
      await resumed.sessionPersistence.appendFenced(sessionId, [{
        type: 'execution/commanded',
        seq: nextSeq + 1,
        time: Date.now(),
        data: executionCommanded({
          execution_id: ExecutionId('exec-3'),
          command: 'resume',
          source: 'recovery',
        }),
      }], { worker_id: 'a4-resume-worker', ownership_epoch: 0 })
      await resumed.fiber.dispose()

      const after = new Context()
      await after.plugin(SessionStore)
      await after.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
      const stateAfter = await deriveAll(after.sessionPersistence, sessionId)
      expect(stateAfter.executions.size).toBe(3)
      expect(stateAfter.last_seq).toBeGreaterThan(rebuilt.last_seq)
      await after.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
