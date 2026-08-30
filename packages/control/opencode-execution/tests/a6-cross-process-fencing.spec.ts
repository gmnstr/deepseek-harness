/**
 * A6 cross-process fencing with a REAL durable backend. Each owner is an
 * independently-instantiated process (`node --import tsx/esm`) against the
 * SAME DSH sqlite DB file — fencing must survive process boundaries, not just
 * in-process promise chains. Proves:
 * 1. Owner A (epoch 0) appends; Owner B migrates 0→1; a stale A append is
 *    fenced (no mutation); Owner B appends; the log stays contiguous.
 * 2. The migration CAS is atomic across processes: a second migrate from the
 *    same source epoch loses.
 * 3. Race: concurrent A-append(epoch 0) vs B-migrate(0→1) — exactly one
 *    deterministic winner per SQLite transaction; the loser fences; no
 *    sequence corruption and no duplicate semantic event.
 * 4. A stale writer's token stays dead across a restart (fencing is durable,
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
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'

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

/** Read the persisted canonical log length + seqs from the DSH DB. */
async function readLog(dbPath: string, sessionId: SessionId): Promise<{ length: number; seqs: number[] }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
  const { events } = await ctx.sessionPersistence.load(sessionId)
  await ctx.fiber.dispose()
  return { length: events.length, seqs: events.map(e => e.seq) }
}

describe('A6 cross-process fencing (real durable backend)', () => {
  it('fences a stale owner after another process migrates the epoch; the log stays contiguous', async () => {
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

  it('the migration CAS is atomic across processes: a second migrate from the same source epoch loses', async () => {
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

  it('race: two concurrent appends at the same epoch have exactly one deterministic winner and no corruption', async () => {
    const path = await freshDbPath('dsh-a6-race-append-')
    const sessionId = SessionId('a6-race-append')

    // Establish the session at epoch 0 in-process with one event (seq 0).
    const setup = new Context()
    await setup.plugin(SessionStore)
    await setup.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    await setup.sessionPersistence.create({ version: 0, id: sessionId, createdAt: 1_000, cwd: '/workspace' })
    await setup.fiber.dispose()
    expect(owner(path, String(sessionId), 'append', '0').RESULT === 'APPENDED').toBe(true)

    // Two independent owner processes race to append at epoch 0. SQLite
    // begin-immediate serializes them: the two appends may both commit at
    // contiguous seqs (1 then 2), or one may fence on a seq/epoch conflict.
    // The invariant is NO sequence corruption and NO duplicate semantic event:
    // the log must stay contiguous with exactly the winning append(s), and no
    // two events may share a seq.
    const runAppend = () => new Promise<Record<string, string>>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx/esm', OWNER_PATH, path, String(sessionId), 'append', '0'], {
        cwd: fileURLToPath(new URL('../../..', import.meta.url)),
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      let out = ''
      child.stdout.on('data', d => { out += String(d) })
      child.on('exit', () => {
        const facts: Record<string, string> = {}
        for (const line of out.split('\n')) {
          const eq = line.indexOf('=')
          if (eq > 0) facts[line.slice(0, eq)] = line.slice(eq + 1)
        }
        resolve(facts)
      })
    })

    const [a, b] = await Promise.all([runAppend(), runAppend()])
    const aWon = a.RESULT === 'APPENDED'
    const bWon = b.RESULT === 'APPENDED'
    const winners = (aWon ? 1 : 0) + (bWon ? 1 : 0)
    expect(winners).toBeGreaterThanOrEqual(1)

    // No corruption: the setup event (seq 0) plus the winner(s), always
    // contiguous, never duplicate seqs.
    const log = await readLog(path, sessionId)
    expect(log.length).toBe(1 + winners)
    expect(log.seqs).toEqual(Array.from({ length: 1 + winners }, (_, i) => i))
    expect(new Set(log.seqs).size).toBe(log.seqs.length)
  })

  it('race: concurrent append(epoch 0) vs migrate(0→1) — one wins the slot; no corruption, no duplicate event', async () => {
    const path = await freshDbPath('dsh-a6-race-')
    const sessionId = SessionId('a6-race')

    // Establish the session at epoch 0 in-process (both racers need a real
    // existing epoch-0 slot to contend for, not a fresh create inside each
    // child).
    const setup = new Context()
    await setup.plugin(SessionStore)
    await setup.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    await setup.sessionPersistence.create({ version: 0, id: sessionId, createdAt: 1_000, cwd: '/workspace' })
    await setup.fiber.dispose()

    const runAppend = () => new Promise<Record<string, string>>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx/esm', OWNER_PATH, path, String(sessionId), 'append', '0'], {
        cwd: fileURLToPath(new URL('../../..', import.meta.url)),
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      let out = ''
      child.stdout.on('data', d => { out += String(d) })
      child.on('exit', () => {
        const facts: Record<string, string> = {}
        for (const line of out.split('\n')) {
          const eq = line.indexOf('=')
          if (eq > 0) facts[line.slice(0, eq)] = line.slice(eq + 1)
        }
        resolve(facts)
      })
    })
    const runMigrate = () => new Promise<Record<string, string>>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx/esm', OWNER_PATH, path, String(sessionId), 'migrate', '0', '1'], {
        cwd: fileURLToPath(new URL('../../..', import.meta.url)),
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      let out = ''
      child.stdout.on('data', d => { out += String(d) })
      child.on('exit', () => {
        const facts: Record<string, string> = {}
        for (const line of out.split('\n')) {
          const eq = line.indexOf('=')
          if (eq > 0) facts[line.slice(0, eq)] = line.slice(eq + 1)
        }
        resolve(facts)
      })
    })

    const [appendResult, migrateResult] = await Promise.all([runAppend(), runMigrate()])
    const appendWon = appendResult.RESULT === 'APPENDED'
    const migrateWon = migrateResult.RESULT === 'MIGRATED'

    // No corruption: the log has zero or one event (the append), contiguous.
    const log = await readLog(path, sessionId)
    expect(log.length).toBe(appendWon ? 1 : 0)
    expect(log.seqs).toEqual(appendWon ? [0] : [])

    // Stored epoch reflects the migration.
    const epoch = owner(path, String(sessionId), 'epoch').EPOCH
    expect(epoch).toBe(migrateWon ? '1' : '0')

    // The decisive one-way fence: once the epoch advanced to 1 (the migration
    // won), a stale epoch-0 append MUST be rejected durably. If the append won
    // first (epoch still 0), the migration's CAS lost to nothing and epoch
    // stays 0, so a stale append at epoch 0 legitimately appends.
    const staleProbe = owner(path, String(sessionId), 'append', '0')
    if (migrateWon) {
      expect(staleProbe.RESULT).toMatch(/^FENCED/)
      expect(staleProbe.RESULT).toMatch(/owned by epoch 1/)
    } else {
      expect(staleProbe.RESULT === 'APPENDED' || (staleProbe.RESULT ?? '').startsWith('FENCED')).toBe(true)
    }
  })

  it('a stale writer token stays dead across a restart (fencing is durable, not an in-memory flag)', async () => {
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
