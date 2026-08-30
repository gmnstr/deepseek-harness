/**
 * Durable stale-writer fencing for the SQLite store: ownership-epoch CAS,
 * fenced append rejection, backward-compatible unfenced append, and the
 * fail-closed JSONL backend.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/tests/fencing
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl, {
  JsonlSessionPersistence,
} from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionPersistenceSqlite, {
  DEFAULT_BUSY_TIMEOUT_MS,
  SessionOwnershipFencedError,
  SqliteStore,
} from '@deepseek-ai/dsh-session-persistence-sqlite'
import { meta } from '../../session-persistence/tests/contract.ts'
import { SqliteSessionPersistence } from '../src/index.ts'
import { sql } from '../src/sql.ts'
import { testSql } from './test-sql.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix = 'dsh-sqlite-fence-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

async function freshDirectory(prefix = 'dsh-jsonl-fence-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return directory
}

function chunk(seq: number, text = `token-${seq}`): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time: 1_000 + seq,
    data: {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text },
    },
  }
}

function writer(ownership_epoch: number, worker_id = 'worker-1'): { worker_id: string; ownership_epoch: number } {
  return { worker_id, ownership_epoch }
}

describe('SQLite ownership-epoch fencing', () => {
  it('lets the current owner (epoch 0) append contiguously', async () => {
    const store = new SqliteStore({ path: ':memory:', journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('owner-epoch-zero')
    await expect(store.appendBatch(header, [chunk(0)], false, 0)).resolves.toBeUndefined()
    await expect(store.appendBatch(header, [chunk(1)], true, 0)).resolves.toBeUndefined()
    expect((await store.loadStored(header.id))?.events).toEqual([chunk(0), chunk(1)])
    await store.close()
  })

  it('rejects a stale-epoch writer with SessionOwnershipFencedError and appends nothing', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-stale-epoch-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('stale-epoch')
    await store.appendBatch(header, [chunk(0)], false, 0)
    await expect(store.appendBatch(header, [chunk(1)], true, 1)).rejects
      .toBeInstanceOf(SessionOwnershipFencedError)
    expect((await store.loadStored(header.id))?.events).toEqual([chunk(0)])
    await store.close()
  })

  it('still rejects a stale expected seq even when the epoch matches', async () => {
    const store = new SqliteStore({ path: ':memory:', journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('stale-seq')
    await store.appendBatch(header, [chunk(0)], false, 0)
    await store.appendBatch(header, [chunk(1)], true, 0)
    await expect(store.appendBatch(header, [chunk(1)], true, 0)).rejects.toThrow(/stored next seq is 2/)
    expect((await store.loadStored(header.id))?.events).toEqual([chunk(0), chunk(1)])
    await store.close()
  })

  it('advances the ownership epoch with the CAS: 0→1 succeeds, 0→1 and 0→2 fail', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-cas-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('epoch-cas')
    await store.appendBatch(header, [chunk(0)], false, 0)
    expect(await store.advanceOwnershipEpoch(header.id, 0, 1)).toBe(true)
    expect(await store.advanceOwnershipEpoch(header.id, 0, 1)).toBe(false)
    expect(await store.advanceOwnershipEpoch(header.id, 0, 2)).toBe(false)
    await store.close()
  })

  it('rejects the old-epoch owner after migration and accepts the new owner', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-migration-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('migrated')
    await store.appendBatch(header, [chunk(0)], false, 0)
    expect(await store.advanceOwnershipEpoch(header.id, 0, 1)).toBe(true)
    await expect(store.appendBatch(header, [chunk(1)], true, 0)).rejects
      .toBeInstanceOf(SessionOwnershipFencedError)
    await expect(store.appendBatch(header, [chunk(1)], true, 1)).resolves.toBeUndefined()
    expect((await store.loadStored(header.id))?.events).toEqual([chunk(0), chunk(1)])
    await store.close()
  })

  it('keeps the epoch durable across a fresh backend instance on the same file', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-durable-')
    const first = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('durable-epoch')
    await first.appendBatch(header, [chunk(0)], false, 0)
    expect(await first.advanceOwnershipEpoch(header.id, 0, 1)).toBe(true)
    await first.close()

    const second = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    await expect(second.appendBatch(header, [chunk(1)], true, 0)).rejects
      .toBeInstanceOf(SessionOwnershipFencedError)
    await expect(second.appendBatch(header, [chunk(1)], true, 1)).resolves.toBeUndefined()
    expect((await second.loadStored(header.id))?.events).toEqual([chunk(0), chunk(1)])
    await second.close()
  })

  it('keeps the epoch on the upsert conflict path so an existing session survives re-materialization', async () => {
    const store = new SqliteStore({ path: ':memory:', journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('upsert-keeps-epoch')
    await store.appendBatch(header, [chunk(0)], false, 0)
    expect(await store.advanceOwnershipEpoch(header.id, 0, 1)).toBe(true)
    // Re-running the lazy materialization must not reset the epoch to 0.
    await expect(store.appendBatch(header, [chunk(1)], false, 1)).resolves.toBeUndefined()
    expect(await store.advanceOwnershipEpoch(header.id, 1, 2)).toBe(true)
    await store.close()
  })

  it('lets an unfenced append (no epoch) keep working for legacy paths', async () => {
    const store = new SqliteStore({ path: ':memory:', journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('unfenced-legacy')
    await expect(store.appendBatch(header, [chunk(0)], false)).resolves.toBeUndefined()
    await expect(store.appendBatch(header, [chunk(1)], true)).resolves.toBeUndefined()
    expect((await store.loadStored(header.id))?.events).toEqual([chunk(0), chunk(1)])
    await store.close()
  })

  it('rejects a stale-epoch repair with SessionOwnershipFencedError and mutates nothing', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-repair-stale-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('repair-stale-epoch')
    await store.appendBatch(header, [chunk(0)], false, 0)
    await store.advanceOwnershipEpoch(header.id, 0, 1)
    const db = new DatabaseSync(path)
    db.prepare(testSql('insert-corrupt-event')).run(header.id, 1, 'assistant/chunk', 2, '{not json', 0)
    db.close()
    expect((await store.loadStored(header.id))?.tornMarker).toBe(1)

    // A stale writer (epoch 0) must not delete the torn tail on a session now
    // owned by epoch 1.
    await expect(store.commitRepair(header, 1, [], 0)).rejects
      .toBeInstanceOf(SessionOwnershipFencedError)
    expect((await store.loadStored(header.id))?.tornMarker).toBe(1)
    await store.close()
  })

  it('accepts a repair whose epoch matches the stored ownership epoch', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-repair-correct-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('repair-correct-epoch')
    await store.appendBatch(header, [chunk(0)], false, 0)
    await store.advanceOwnershipEpoch(header.id, 0, 1)
    const db = new DatabaseSync(path)
    db.prepare(testSql('insert-corrupt-event')).run(header.id, 1, 'assistant/chunk', 2, '{not json', 0)
    db.close()
    expect((await store.loadStored(header.id))?.tornMarker).toBe(1)

    // The current owner (epoch 1) may repair: the tail is deleted and the log
    // becomes contiguous at seq 1.
    await expect(store.commitRepair(header, 1, [], 1)).resolves.toBeUndefined()
    expect((await store.loadStored(header.id))?.tornMarker).toBeUndefined()
    expect((await store.loadStored(header.id))?.events).toEqual([chunk(0)])
    await store.close()
  })

  it('lets an unfenced repair (no epoch) keep working for legacy paths', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-repair-unfenced-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('repair-unfenced')
    await store.appendBatch(header, [chunk(0)], false, 0)
    await store.advanceOwnershipEpoch(header.id, 0, 1)
    const db = new DatabaseSync(path)
    db.prepare(testSql('insert-corrupt-event')).run(header.id, 1, 'assistant/chunk', 2, '{not json', 0)
    db.close()
    expect((await store.loadStored(header.id))?.tornMarker).toBe(1)

    // The legacy unfenced form (no epoch) must behave exactly as before.
    await expect(store.commitRepair(header, 1, [])).resolves.toBeUndefined()
    expect((await store.loadStored(header.id))?.tornMarker).toBeUndefined()
    expect((await store.loadStored(header.id))?.events).toEqual([chunk(0)])
    await store.close()
  })

  it('rejects a fenced append that targets a missing metadata row after an unfenced lazy write failed', async () => {
    const store = new SqliteStore({ path: ':memory:', journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('missing-row-fence')
    // The lazy write with a wrong first seq rolls back, so no metadata row exists.
    await expect(store.appendBatch(header, [chunk(1)], false, 0)).rejects.toThrow(/stored next seq is 0/)
    await expect(store.appendBatch(header, [chunk(0)], true, 0)).rejects.toThrow(/metadata row is missing/)
    await store.close()
  })

  it('declares fencing support on the service and surfaces the store error class', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
    expect(ctx.sessionPersistence.ownershipSupport).toBe('FENCING_SUPPORTED')
    await ctx.fiber.dispose()
    expect(SessionOwnershipFencedError.name).toBe('SessionOwnershipFencedError')
  })
})

describe('coordinator appendFenced pass-through', () => {
  it('persists through the fenced surface and rejects a stale epoch via the service', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-service-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
    try {
      const header = meta('fenced-service')
      await ctx.sessionPersistence.create(header)
      await ctx.sessionPersistence.appendFenced(header.id, [chunk(0)], writer(0))
      const events = (await ctx.sessionPersistence.inspect(header.id)).events
      expect(events).toEqual([chunk(0)])
    } finally {
      await fiber.dispose()
    }
  })

  it('rejects a non-fencing default surface and the JSONL backend fails closed', async () => {
    const root = await freshDirectory('dsh-jsonl-fence-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceJsonl, { root })
    const header = meta('jsonl-fenced')
    await ctx.sessionPersistence.create(header)
    await expect(ctx.sessionPersistence.appendFenced(header.id, [chunk(0)], writer(0)))
      .rejects.toThrow(/does not support fenced appends|refusing the fenced append form/)
    expect(ctx.sessionPersistence.ownershipSupport).toBe('UNSUPPORTED_FAIL_CLOSED')
    await ctx.fiber.dispose()
  })

  it('rejects the fenced repair form on the JSONL backend instead of dropping the fence', async () => {
    const root = await freshDirectory('dsh-jsonl-fence-repair-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let backend!: JsonlSessionPersistence
    await ctx.plugin(Object.assign((inner: Context) => {
      backend = new JsonlSessionPersistence(inner, { root })
    }, { inject: ['sessions'] }))
    const header = meta('jsonl-fenced-repair')
    await expect(backend.commitRepair(header, undefined, [], 0))
      .rejects.toThrow(/refusing the fenced repair form/)
    await ctx.fiber.dispose()
  })

  it('throws on an invalid writer token before touching storage', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
    const header = meta('invalid-writer')
    await ctx.sessionPersistence.create(header)
    await expect(ctx.sessionPersistence.appendFenced(header.id, [chunk(0)], writer(-1)))
      .rejects.toThrow(/ownership_epoch must be a non-negative safe integer/)
    await expect(ctx.sessionPersistence.appendFenced(header.id, [chunk(0)], { worker_id: '', ownership_epoch: 0 }))
      .rejects.toThrow(/worker_id must be a non-empty string/)
    await ctx.fiber.dispose()
  })
})

describe('fencing schema ownership', () => {
  it('exposes the ownership epoch column in stored session rows', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-column-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('epoch-column')
    await store.appendBatch(header, [chunk(0)], false, 0)
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const row = db.prepare(testSql('select-session-epoch')).get(header.id) as { ownership_epoch: number }
      expect(row.ownership_epoch).toBe(0)
    } finally {
      db.close()
    }
    await store.close()
  })

  it('rejects an older physical schema (version 19) as incompatible', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-old-schema-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
    try {
      const header = meta('old-schema')
      await ctx.sessionPersistence.create(header)
      await ctx.sessionPersistence.append(header.id, [chunk(0)])
    } finally {
      await fiber.dispose()
    }
    // Force the user version down to a pre-epoch schema; opening must reject.
    const downgraded = new DatabaseSync(path)
    downgraded.exec(testSql('set-user-version-19'))
    downgraded.close()
    await expect(
      new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS }).open(),
    ).rejects.toThrow(/schema version 19.*incompatible/)
  })

  it('packages the ownership_epoch column in the canonical schema', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(sql('schema'))
      const rows = db.prepare(testSql('select-session-columns')).all('ownership_epoch') as Array<{ name: string }>
      expect(rows).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})

describe('coordinator epoch bookkeeping', () => {
  it('adopts the stored epoch after a fenced migration from a second instance', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-adopt-')
    const first = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('adopt-epoch')
    await first.appendBatch(header, [chunk(0)], false, 0)
    await first.advanceOwnershipEpoch(header.id, 0, 1)
    await first.close()

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
    try {
      await ctx.sessionPersistence.appendFenced(header.id, [chunk(1)], writer(1))
      const events = (await ctx.sessionPersistence.inspect(header.id)).events
      expect(events).toEqual([chunk(0), chunk(1)])
    } finally {
      await fiber.dispose()
    }
  })

  it('exposes the ownership epoch through the store hook', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-hook-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('fence-hook')
    await store.appendBatch(header, [chunk(0)], false, 0)
    expect(await store.ownershipEpochOf(header.id)).toBe(0)
    await store.advanceOwnershipEpoch(header.id, 0, 3)
    expect(await store.ownershipEpochOf(header.id)).toBe(3)
    await store.close()
  })
})

describe('SQLite service fencing surface', () => {
  it('declares FENCING_SUPPORTED and rejects stale writers through the service', async () => {
    const path = await freshDbPath('dsh-sqlite-fence-surface-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
    try {
      expect((ctx.sessionPersistence as SqliteSessionPersistence).ownershipSupport).toBe('FENCING_SUPPORTED')
      const header = meta('fence-surface')
      await ctx.sessionPersistence.create(header)
      await ctx.sessionPersistence.appendFenced(header.id, [chunk(0)], writer(0))
      await expect(ctx.sessionPersistence.appendFenced(header.id, [chunk(1)], writer(1)))
        .rejects.toBeInstanceOf(SessionOwnershipFencedError)
    } finally {
      await fiber.dispose()
    }
  })
})
