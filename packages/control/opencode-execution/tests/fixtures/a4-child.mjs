/**
 * A4 child-process derivation entry. Spawned with `node --import tsx/esm` by
 * the delete/rebuild gate (`tests/a4-delete-rebuild.spec.ts`). It opens ONLY
 * the DSH sqlite DB (never a derived projection on disk) and derives the read
 * model from the canonical log, printing the digest. A genuine process
 * boundary: the parent's in-memory runtime is gone.
 * @module @deepseek-ai/dsh-opencode-execution/tests/fixtures/a4-child
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { deriveAll } from '@deepseek-ai/dsh-opencode-execution'

const [dbPath, sessionId, tag] = process.argv.slice(2)
if (dbPath === undefined || sessionId === undefined || tag === undefined) {
  console.error('usage: a4-child.mjs <dbPath> <sessionId> <tag>')
  process.exit(1)
}
const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
const state = await deriveAll(ctx.sessionPersistence, SessionId(sessionId))
console.log(`TAG=${tag}`)
console.log(`DIGEST=${state.digest}`)
console.log(`LASTSEQ=${state.last_seq}`)
console.log(`EXECUTIONS=${state.executions.size}`)
console.log(`ACTIVITIES=${state.activities.length}`)
console.log(`EFFECTS=${state.effects.size}`)
console.log(`PENDING_AMBI=${Array.from(state.effects.values()).filter(e => e.outcome === 'commit-unknown').length}`)
await ctx.fiber.dispose()
