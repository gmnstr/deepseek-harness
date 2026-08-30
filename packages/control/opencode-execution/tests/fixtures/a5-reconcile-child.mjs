/**
 * A5 child-process reconcile entry. Spawned with `node --import tsx/esm` by
 * `tests/a5-ambiguous-effect-recovery.spec.ts`. Opens ONLY the DSH sqlite DB,
 * derives the pending effect state (finding the commit-unknown), reconciles it
 * against a deterministic fake external system (checking the fake's own truth,
 * never re-applying the mutation), appends effect/reconciled canonically, and
 * prints the reconciled derived state. A genuine process boundary: the
 * crashing parent's in-memory runtime is gone; reconciliation happens in a
 * fresh process from the persisted DSH log alone.
 * @module @deepseek-ai/dsh-opencode-execution/tests/fixtures/a5-reconcile-child
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { CapabilityKernel, ExecutionRuntime, EffectExecutor } from '@deepseek-ai/dsh-opencode-execution'

/** Deterministic fake external system: the fake's own truth, never the DSH log. */
const externalDb = new Map()
if (process.env.A5_PRE_SEED) {
  // The parent committed the mutation before the response was lost; the
  // reconciler observes the external system's truth and must NOT re-apply.
  for (const entry of process.env.A5_PRE_SEED.split(';')) {
    const [key, value] = entry.split('=')
    if (key) externalDb.set(key, value)
  }
}

const worker = {
  operation: 'fs.patch',
  async execute(attempt) {
    if (attempt.reconcile) {
      // Probe external state — never re-apply an IRREVERSIBLE mutation.
      if (externalDb.has(attempt.resource)) {
        return { kind: 'succeeded', receipt: { resource: attempt.resource, reconciled: true } }
      }
      return { kind: 'failed', error: 'not committed' }
    }
    externalDb.set(attempt.resource, String(attempt.payload ?? 'patch'))
    return { kind: 'succeeded', receipt: { resource: attempt.resource } }
  },
}

const [dbPath, sessionIdArg, actionIdArg, resourceArg] = process.argv.slice(2)
if (!dbPath || !sessionIdArg || !actionIdArg || !resourceArg) {
  console.error('usage: a5-reconcile-child.mjs <dbPath> <sessionId> <actionId> <resource>')
  process.exit(1)
}

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
const runtime = new ExecutionRuntime({
  persistence: ctx.sessionPersistence,
  session_id: SessionId(sessionIdArg),
  writer: { worker_id: `a5-child-${process.pid}`, ownership_epoch: 0 },
})
const kernel = new CapabilityKernel()
const executor = new EffectExecutor({
  runtime,
  kernel,
  workers: new Map([['fs.patch', worker]]),
})

const derivedBefore = await runtime.derive()
const before = derivedBefore.effects.get(actionIdArg)
console.log(`BEFORE_OUTCOME=${before ? before.outcome : '(none)'}`)

if (process.env.A5_DERIVE_ONLY === '1') {
  // Derive-only mode: prove a fresh process reads the canonical state without
  // performing any mutation (used for the second-restart assertion).
  const after = await runtime.derive()
  const effect = after.effects.get(actionIdArg)
  console.log(`AFTER_OUTCOME=${effect ? effect.outcome : '(none)'}`)
  console.log(`ATTEMPT_IDS=${JSON.stringify(effect ? effect.attempt_ids : [])}`)
  console.log(`DIGEST=${after.digest}`)
  await ctx.fiber.dispose()
  process.exit(0)
}

const result = await executor.reconcile({
  action_id: actionIdArg,
  resource: resourceArg,
  payload: { probe: true },
})

const after = await runtime.derive()
const effect = after.effects.get(actionIdArg)
console.log(`RECONCILE_RESULT=${result.result ? result.result.outcome.kind : '(null)'}`)
console.log(`RECONCILE_ATTEMPT=${result.result ? String(result.result.attempt_id) : ''}`)
console.log(`AFTER_OUTCOME=${effect ? effect.outcome : '(none)'}`)
console.log(`ATTEMPT_IDS=${JSON.stringify(effect ? effect.attempt_ids : [])}`)
console.log(`DIGEST=${after.digest}`)
await ctx.fiber.dispose()
