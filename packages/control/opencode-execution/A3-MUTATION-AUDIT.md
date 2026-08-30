# A3 Mutation Audit — old `ExecutionLedger` entry points → DSH-canonical counterparts

Scope: `packages/control/opencode-execution` (this package) plus the two public passthroughs on `SqliteSessionPersistence`. This table maps every old `ExecutionLedger` mutation entry point (the frozen P0–P3 prototype at `integration/execution-contract/ledger.ts` in the integration repo) to its new DSH-canonical counterpart and the disposition of the old path.

| Old `ExecutionLedger` entry point | Old role | New DSH-canonical counterpart | Disposition |
|---|---|---|---|
| `ExecutionLedger.open(path)` / `memory()` (bun:sqlite `Database`) | Independent SQLite-backed control ledger | Real DSH `SessionPersistenceSqlite` over the DSH session log | **Removed** — the derived runtime never owns a SQLite write path; tests use `node:sqlite` only through `SessionPersistenceSqlite` |
| `ledger.append(writer, event)` | Atomic single-event append fenced on (expected_sequence, ownership_epoch) | `ctx.sessionPersistence.appendFenced(id, [event], writer)` (A2 fencing in `appendBatch` + `assertEpoch`) | **Replaced** — canonical writes move to real DSH persistence |
| `ledger.appendBatch(writer, events)` | Atomic multi-append under one epoch | `ctx.sessionPersistence.appendFenced(id, events, writer)` | **Replaced** — DSH batches carry the same contiguity + epoch contract |
| `ledger.advanceEpoch(session, from, to)` | Ownership migration CAS | `SqliteSessionPersistence.advanceOwnershipEpoch(id, from, to)` (new public passthrough → `SqliteStore.advanceOwnershipEpoch`), invoked by `ExecutionRuntime.migrateOwnership` | **Replaced** — CAS semantics identical; never appends an `OwnershipMigrated` event |
| `ledger.ensureSession(session, epoch)` | Materialize per-session counter row | `ctx.sessionPersistence.create(meta)` (DSH lazy materialization; fresh sessions default epoch 0) | **Replaced** — DSH owns the header |
| `ledger.currentState(session)` | Read expected_sequence/epoch | `ctx.sessionPersistence.load(id)` + fold (`readFromDsh`/`deriveAll`) | **Demoted to derived read** — the DSH log is the only authority |
| `ledger.readEvents(session)` | Read all canonical events | `readFromDsh(persistence, sessionId)` → `persistence.load(id)` | **Demoted to derived read** — same facts, DSH-owned storage |
| `ledger.writeSnapshot` / `readSnapshot` / `deleteSnapshot` | Snapshot digest optimization | Fold digest (`foldProjection` → `DerivedSessionState.digest`) | **Demoted to derived read** — the digest is recomputed, never stored |
| `ledger.isEmpty(session)` | Presence check | `persistence.load(id)` and inspect the log | **Demoted to derived read** |
| `ledger.close()` | Close bun:sqlite handle | `ctx.fiber.dispose()` (DSH owns backend lifecycle) | **Removed** — DSH lifecycle owns the backend |
| `SessionActorImpl.append(...)` (session-actor.ts) | Actor canonical appends (`CommandAccepted`, `ActivityRequested`, `TurnEnded`, `ExecutionSettled`, `OwnershipMigrated`) | `ExecutionRuntime.appendControl(type, payload)` → `appendFenced` using the A1 factories (`execution/commanded`, `activity/correlated`, `effect/*`) | **Replaced** — A1 control vocabulary names the same facts; `OwnershipMigrated` is NOT an event (fencing is persistence metadata) |
| `SessionActorImpl.migrateOwnership(...)` | Appends `OwnershipMigrated` then CAS | `ExecutionRuntime.migrateOwnership(from, to, worker)` — CAS only, never an event | **Replaced + corrected** — the event form is gone per the A1 decision |
| `EffectExecutor.append(...)` (effects.ts) | Effect event appends (`EffectAuthorized`, `EffectAttemptStarted`, `EffectSucceeded`, `EffectFailed`, `EffectCommitUnknown`, `EffectRejected`) | `ExecutionRuntime` control appends via the A1 factories (`effect/requested`, `effect/authorized`, `effect/denied`, `effect/attempt-started`, `effect/succeeded`, `effect/failed`, `effect/commit-unknown`, `effect/reconciled`) | **Replaced** — one vocabulary, DSH-backed; denial is a first-class `effect/denied` (old `EffectRejected` folded into it) |
| `EffectOutbox.enqueue/claim/markDispatched/complete` | In-memory durable-outbox record | `EffectExecutor.outbox()` — working view derived from the DSH log fold | **Demoted to derived** — the outbox is a derived working view, never durable truth |
| `outboxFromLedger(...)` | Reconstruct outbox from ledger events | `EffectExecutor.outbox()` folds `effect/*` from the DSH log | **Demoted to derived read** |

## Disposition legend

- **Removed** — the path no longer exists; the DSH-canonical path fully replaces it.
- **Replaced** — same fact/transition, written canonically through DSH persistence.
- **Demoted to derived** — the old authoritative read/write became a read-model projection of the DSH log.
- **Test-only** — any remaining references live in the frozen integration-repo prototype, which A7 reconciles; this package contains none.

## Invariant

The derived runtime owns NO independent authoritative write API. Any call that would mutate derived state directly from runtime memory is forbidden; derived writes only follow DSH events. After a crash, a fresh runtime loads the persisted DSH log and rebuilds the projection (delete-and-rebuild independence is asserted in `tests/projection.spec.ts`).
