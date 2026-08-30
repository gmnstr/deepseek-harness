/**
 * A6 cross-process fencing with a REAL durable backend. Each owner is an
 * independently-instantiated process (`node --import tsx/esm`) against the
 * SAME DSH sqlite DB file — fencing must survive process boundaries, not just
 * in-process promise chains. Proves:
 * 1. Owner A (epoch 0) appends; Owner B migrates 0→1; a stale A append is
 *    fenced (no mutation); Owner B appends; the log stays contiguous.
 * 2. The migration CAS is atomic across processes: a second migrate from the
 *    same source epoch loses.
 * 3. Race: concurrent same-epoch appends — serialized by SQLite
 *    `begin-immediate`, no sequence corruption and no duplicate semantic
 *    event, each loser classified by its real failure class.
 * 4. Race: append(epoch 0) vs migrate(0→1) on a GENUINELY durable epoch-0
 *    slot (row materialized + event seq 0 committed before any racer starts).
 *    Both legal orderings are proven reachable and safe: migration-first →
 *    stale epoch-0 append is durably fenced; append-first → the append
 *    commits at seq 1 and the migrate CAS still wins after (epoch → 1), so
 *    the stale probe is fenced either way. Final epoch/log state matches the
 *    actual transaction winner; no sequence corruption and no duplicate
 *    semantic event.
 * 5. A stale writer's token stays dead across a restart (fencing is durable,
 *    not an in-memory flag).
 * @module @deepseek-ai/dsh-opencode-execution/tests/a6-cross-process-fencing
 */

import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { executionCommanded, ExecutionId } from '@deepseek-ai/dsh-opencode-control'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

const OWNER_PATH = join(import.meta.dirname, 'fixtures', 'a6-owner.mjs')

/** Run one owner process; returns its printed facts. */
function owner(dbPath: string, sessionId: string, ...args: string[]): Record<string, string> {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx/esm', OWNER_PATH, dbPath, sessionId, ...args],
    { encoding: 'utf8', cwd: fileURLToPath(new URL('../../..', import.meta.url)) },
  )
  const facts: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) facts[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return facts
}

/**
 * Genuinely materialize a durable epoch-0 session: `create()` only records
 * intent (no SQLite row until the first append), so `create()` alone cannot
 * give the migration CAS a real row to contend for. A real append at epoch 0
 * (event seq 0) commits the metadata row + event through the service, making
 * the epoch-0 slot durable before any racer starts. The appended event is the
 * caller's setup event; the log therefore starts at seq 0.
 */
async function setupEpochZeroSession(dbPath: string, sessionId: SessionId): Promise<void> {
  const setup = new Context()
  await setup.plugin(SessionStore)
  await setup.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
  await setup.sessionPersistence.create({ version: 0, id: sessionId, createdAt: 1_000, cwd: '/workspace' })
  const setupEvent: SessionEvent = {
    type: 'execution/commanded',
    seq: 0,
    time: 1_000,
    data: executionCommanded({ execution_id: ExecutionId('setup'), command: 'setup', source: 'surface' }),
  }
  await setup.sessionPersistence.appendFenced(sessionId, [setupEvent], { worker_id: 'a6-setup', ownership_epoch: 0 })
  await setup.fiber.dispose()
}

/** Read the persisted canonical log length + seqs from the DSH DB. */
async function readLog(dbPath: string, sessionId: SessionId): Promise<{ length: number; seqs: number[] }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
  const { events } = await ctx.sessionPersistence.load(sessionId)
  await ctx.fiber.dispose()
  return { length: events.length, seqs: events.map(e => e.seq) }
}

/** Spawn one owner child process asynchronously; rejects on non-zero exit. */
function runOwnerChild(dbPath: string, sessionId: string, ...args: string[]): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', OWNER_PATH, dbPath, sessionId, ...args],
      {
        cwd: fileURLToPath(new URL('../../..', import.meta.url)),
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    let out = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.on('error', reject)
    child.on('exit', (code) => {
      const facts: Record<string, string> = {}
      for (const line of out.split('\n')) {
        const eq = line.indexOf('=')
        if (eq > 0) facts[line.slice(0, eq)] = line.slice(eq + 1)
      }
      // The fixture exits non-zero ONLY on an unexpected failure (RESULT=ERROR
      // or a crash). An unexpected error must FAIL the test, never be
      // mistaken for valid fencing evidence.
      if (code !== 0 && !facts.RESULT?.startsWith('FENCED') && !facts.RESULT?.startsWith('SEQ_CONFLICT')) {
        reject(new Error(`owner child exited ${code} with ${JSON.stringify(facts)}`))
        return
      }
      resolve(facts)
    })
  })
}

describe('A6 cross-process fencing (real durable backend)', () => {
  it('fences a stale owner after another process migrates the epoch; the log stays contiguous', { timeout: 30_000 }, async () => {
    const path = await freshDbPath('dsh-a6-seq-')
    const sessionId = SessionId('a6-seq')

    // Owner A (epoch 0) appends.
    expect(owner(path, String(sessionId), 'append', '0').RESULT === 'APPENDED').toBe(true)

    // Owner B migrates 0→1.
    expect(owner(path, String(sessionId), 'migrate', '0', '1').RESULT === 'MIGRATED').toBe(true)

    // A stale A append is fenced (no mutation).
    const stale = owner(path, String(sessionId), 'append', '0')
    expect(stale.RESULT).toMatch(/^FENCED/)
    expect(stale.RESULT).toMatch(/owned by epoch 1/)

    // Owner B (epoch 1) appends successfully.
    expect(owner(path, String(sessionId), 'append', '1').RESULT === 'APPENDED').toBe(true)

    // Stored epoch is 1; log has exactly the two appended commands, contiguous.
    expect(owner(path, String(sessionId), 'epoch').EPOCH).toBe('1')
    const log = await readLog(path, sessionId)
    expect(log.length).toBe(2)
    expect(log.seqs).toEqual([0, 1])
  })

  it('the migration CAS is atomic across processes: a second migrate from the same source epoch loses', { timeout: 30_000 }, async () => {
    const path = await freshDbPath('dsh-a6-cas-')
    const sessionId = SessionId('a6-cas')

    // Owner A appends under epoch 0.
    expect(owner(path, String(sessionId), 'append', '0').RESULT === 'APPENDED').toBe(true)

    // First migrate wins.
    expect(owner(path, String(sessionId), 'migrate', '0', '1').RESULT === 'MIGRATED').toBe(true)

    // Second migrate from 0 → 2 loses (stored epoch is already 1).
    expect(owner(path, String(sessionId), 'migrate', '0', '2').RESULT === 'MIGRATE_LOST').toBe(true)

    // A migrate from the CURRENT epoch wins: 1 → 2.
    expect(owner(path, String(sessionId), 'migrate', '1', '2').RESULT === 'MIGRATED').toBe(true)
    expect(owner(path, String(sessionId), 'epoch').EPOCH).toBe('2')
  })

  it('race: two concurrent appends at the same epoch serialize with no corruption; losers are seq-conflicts, never fencing', { timeout: 30_000 }, async () => {
    const path = await freshDbPath('dsh-a6-race-append-')
    const sessionId = SessionId('a6-race-append')

    // A genuinely durable epoch-0 slot: metadata row + event seq 0 committed.
    await setupEpochZeroSession(path, sessionId)

    // Two independent owner processes race to append at epoch 0. SQLite
    // begin-immediate serializes them: both appends may commit at contiguous
    // seqs (1 then 2), or the loser may re-derive a stale cursor and hit a
    // seq-conflict. Same-epoch appends can NEVER produce a fencing rejection
    // (the epoch matches), so a FENCED result here would be an unexpected
    // defect; an ERROR result would fail the test via the child exit code.
    const [a, b] = await Promise.all([
      runOwnerChild(path, String(sessionId), 'append', '0'),
      runOwnerChild(path, String(sessionId), 'append', '0'),
    ])
    for (const result of [a, b]) {
      expect(['APPENDED', 'SEQ_CONFLICT'].includes(result.RESULT ?? '')).toBe(true)
    }
    const winners = (a.RESULT === 'APPENDED' ? 1 : 0) + (b.RESULT === 'APPENDED' ? 1 : 0)
    expect(winners).toBeGreaterThanOrEqual(1)

    // No corruption: the setup event (seq 0) plus the winner(s), always
    // contiguous, never duplicate seqs.
    const log = await readLog(path, sessionId)
    expect(log.length).toBe(1 + winners)
    expect(log.seqs).toEqual(Array.from({ length: 1 + winners }, (_, i) => i))
    expect(new Set(log.seqs).size).toBe(log.seqs.length)
  })

  it('append vs migrate on a durable epoch-0 slot: migration-first durably fences the stale writer', { timeout: 30_000 }, async () => {
    const path = await freshDbPath('dsh-a6-race-migrate-first-')
    const sessionId = SessionId('a6-race-migrate-first')

    // A genuinely durable epoch-0 slot: metadata row + event seq 0 committed.
    // Both racers contend for this REAL row — the migration CAS targets an
    // existing row, so migrate-first is genuinely reachable.
    await setupEpochZeroSession(path, sessionId)

    // FORCED migration-first ordering: migrate wins the slot before the
    // append starts.
    expect(owner(path, String(sessionId), 'migrate', '0', '1').RESULT === 'MIGRATED').toBe(true)

    // The stale epoch-0 append MUST be durably fenced (classified by the real
    // SessionOwnershipFencedError type, message pinning the stored epoch 1).
    const stale = owner(path, String(sessionId), 'append', '0')
    expect(stale.RESULT).toMatch(/^FENCED/)
    expect(stale.RESULT).toMatch(/owned by epoch 1/)

    // Final state matches the actual winner: epoch 1, log = [0] (only the
    // setup event; the stale append mutated nothing).
    expect(owner(path, String(sessionId), 'epoch').EPOCH).toBe('1')
    const log = await readLog(path, sessionId)
    expect(log.length).toBe(1)
    expect(log.seqs).toEqual([0])
  })

  it('append vs migrate on a durable epoch-0 slot: append-first commits, then the CAS still migrates and fences the stale token', { timeout: 30_000 }, async () => {
    const path = await freshDbPath('dsh-a6-race-append-first-')
    const sessionId = SessionId('a6-race-append-first')

    // A genuinely durable epoch-0 slot: metadata row + event seq 0 committed.
    await setupEpochZeroSession(path, sessionId)

    // FORCED append-first ordering: the epoch-0 append commits first (seq 1).
    expect(owner(path, String(sessionId), 'append', '0').RESULT === 'APPENDED').toBe(true)

    // The migration CAS is sequence-independent: it advances the epoch even
    // though the append committed first (the stored epoch was still 0).
    expect(owner(path, String(sessionId), 'migrate', '0', '1').RESULT === 'MIGRATED').toBe(true)

    // The stale epoch-0 token is now fenced durably.
    const stale = owner(path, String(sessionId), 'append', '0')
    expect(stale.RESULT).toMatch(/^FENCED/)
    expect(stale.RESULT).toMatch(/owned by epoch 1/)

    // Final state matches the actual winner: epoch 1, log = [0, 1] (the
    // setup event plus the append that won the seq slot), contiguous.
    expect(owner(path, String(sessionId), 'epoch').EPOCH).toBe('1')
    const log = await readLog(path, sessionId)
    expect(log.length).toBe(2)
    expect(log.seqs).toEqual([0, 1])
  })

  it('race: concurrent append(epoch 0) vs migrate(0→1) on a durable slot — no corruption, no duplicate event, final state matches the winner', { timeout: 30_000 }, async () => {
    const path = await freshDbPath('dsh-a6-race-')
    const sessionId = SessionId('a6-race')

    // A genuinely durable epoch-0 slot: metadata row + event seq 0 committed.
    // Both racers contend for this REAL row; the migration CAS cannot win
    // vacuously against an absent row (the A6-1 vacuity defect).
    await setupEpochZeroSession(path, sessionId)

    const [appendResult, migrateResult] = await Promise.all([
      runOwnerChild(path, String(sessionId), 'append', '0'),
      runOwnerChild(path, String(sessionId), 'migrate', '0', '1'),
    ])
    // The append either commits (APPENDED) or is durably fenced (FENCED) —
    // never a seq-conflict (the append targets the fresh tail) and never an
    // unexpected ERROR. runOwnerChild already rejects on an unexpected exit.
    expect(appendResult.RESULT === 'APPENDED' || (appendResult.RESULT ?? '').startsWith('FENCED')).toBe(true)
    // The migration CAS ALWAYS wins here: if the append commits first (epoch
    // still 0), the CAS still advances 0→1; if the migration wins first, the
    // append fences. Either way the stored epoch ends at 1.
    expect(migrateResult.RESULT === 'MIGRATED').toBe(true)
    const appendWon = appendResult.RESULT === 'APPENDED'

    // No corruption: the log is the setup event (seq 0) plus the append if
    // and only if it won — always contiguous, never duplicate seqs.
    const log = await readLog(path, sessionId)
    expect(log.length).toBe(appendWon ? 2 : 1)
    expect(log.seqs).toEqual(appendWon ? [0, 1] : [0])

    // Stored epoch is 1 in every ordering.
    expect(owner(path, String(sessionId), 'epoch').EPOCH).toBe('1')

    // The decisive one-way fence: after the race, the epoch is 1, so a stale
    // epoch-0 append MUST be rejected durably — whether or not the racing
    // append committed.
    const staleProbe = owner(path, String(sessionId), 'append', '0')
    expect(staleProbe.RESULT).toMatch(/^FENCED/)
    expect(staleProbe.RESULT).toMatch(/owned by epoch 1/)
  })

  it('a stale writer token stays dead across a restart (fencing is durable, not an in-memory flag)', { timeout: 30_000 }, async () => {
    const path = await freshDbPath('dsh-a6-restart-')
    const sessionId = SessionId('a6-restart')

    // Owner A appends and migrates to epoch 1.
    expect(owner(path, String(sessionId), 'append', '0').RESULT === 'APPENDED').toBe(true)
    expect(owner(path, String(sessionId), 'migrate', '0', '1').RESULT === 'MIGRATED').toBe(true)

    // Simulate A "crashing" and restarting: A holds its stale epoch-0 token
    // from before the migration. Even after restart (a brand-new process), the
    // durable stored epoch fences it.
    const restarted = owner(path, String(sessionId), 'append', '0')
    expect(restarted.RESULT).toMatch(/^FENCED/)
    expect(restarted.RESULT).toMatch(/owned by epoch 1/)
  })
})
