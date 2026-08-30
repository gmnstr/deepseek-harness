---
description: "Derived-projection execution runtime for the DeepSeek Harness session log: folds the canonical DSH log (native + control events) into execution/activity/authority/effect read models and writes control facts canonically through fenced DSH persistence, for maintainers composing execution runtimes or debugging effect authority."
kind: "package-reference"
---

# @deepseek-ai/dsh-opencode-execution

English | [中文](README.zh.md)

## Summary

`dsh-opencode-execution` is the derived-projection runtime that replaces the old `ExecutionLedger` authority. It treats one DSH session as the SOLE canonical authority for agent execution state: the runtime writes control facts canonically to real DSH persistence through `ctx.sessionPersistence.appendFenced` using the A1 control-event factories, and folds the canonical DSH log (native + control events) into derived read models — executions, activities, authorities, and effects. Every derived write derives SOLELY from DSH events, never from executor or actor memory. The package owns NO independent authoritative write API.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when a control surface (an automation loop, a hook bridge, an agent command runner) must run a serialized execution lifecycle whose durable facts live in the DSH session log — the same log that already carries the model transcript — with real stale-writer fencing.

### What it adds

- **`ExecutionRuntime`** — a serialized session actor. `beginExecution`, `correlateActivity`, `requestEffect` / `authorizeEffect` / `denyEffect` / `startAttempt` / `succeedEffect` / `failEffect` / `commitUnknown` / `reconcileEffect` each append the matching A1 control event through `appendFenced`. `migrateOwnership(from, to, worker)` advances the durable ownership epoch with an atomic CAS (`advanceOwnershipEpoch`) and never appends an `OwnershipMigrated` event — fencing is persistence metadata, not an event.
- **`EffectExecutor`** — kernel-gated effect safety on real DSH backing: structural validation → typed capability authorize → canonical `effect/requested` + `effect/authorized`/`effect/denied` → derived outbox working view → scoped worker with retries (each retry appends a distinct `effect/attempt-started`) → canonical outcome. `commit-unknown` breaks the loop (never blind-retry IRREVERSIBLE); a dedicated `reconcile()` resolves only `commit-unknown` actions with the distinct `${action_id}:reconcile:1` attempt id and `reconcile: true`.
- **`foldProjection`** — the pure, deterministic fold: the same DSH events always produce an identical `DerivedSessionState`, and its sha256 digest changes when any event's type, seq, or data changes. Derived state is a function of the DSH log alone.
- **`CapabilityKernel`** — the typed authority boundary: positive scoped capabilities minted out-of-band; absence means denial; text can never confer authority.

### Building a runtime

```ts
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { ExecutionId } from '@deepseek-ai/dsh-opencode-control'
import { ExecutionRuntime } from '@deepseek-ai/dsh-opencode-execution'

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(SessionPersistenceSqlite, { path: '/tmp/sessions.db' })
const sessionId = SessionId('run-1')
await ctx.sessionPersistence.create({ version: 0, id: sessionId, createdAt: Date.now(), cwd: '/workspace' })

const runtime = new ExecutionRuntime({
  persistence: ctx.sessionPersistence as InstanceType<typeof SessionPersistenceSqlite>,
  session_id: sessionId,
  writer: { worker_id: `worker-${process.pid}`, ownership_epoch: 0 },
})
await runtime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface')
```

The runtime writes only through `appendFenced`; a writer whose epoch no longer matches the stored session is rejected before any event row commits (`SessionOwnershipFencedError`).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable contract is covered in [Use this package](#use-this-package); this section explains how the canonical write path, the derived fold, and the demoted ledger cooperate.

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Type-only derived read models (`DerivedSessionState`, `DerivedExecution`, `DerivedActivity`, `DerivedAuthority`, `DerivedEffect`, `DerivedEffectOutcome`, `ProjectionWriter`) |
| [`src/projection.ts`](src/projection.ts) | The pure deterministic fold (`foldProjection`) with a sha256 digest over canonical facts |
| [`src/ledger-deriver.ts`](src/ledger-deriver.ts) | `readFromDsh` / `deriveAll` — the demoted-write-path audit surface |
| [`src/capability.ts`](src/capability.ts) | Typed `CapabilityKernel`: positive authority, absence = deny, text never confers authority |
| [`src/execution-runtime.ts`](src/execution-runtime.ts) | Serialized session actor; the ONLY canonical write entry point (`appendControl` → `appendFenced`) |
| [`src/effect-executor.ts`](src/effect-executor.ts) | Kernel-gated effect dispatch, retries, `commit-unknown` → `reconcile()`, `ERR_EFFECT_REENTRY` guard |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: no in-process relation to observe (projection and runtime tests own the checks) |
| [`A3-MUTATION-AUDIT.md`](A3-MUTATION-AUDIT.md) | Every old `ExecutionLedger` mutation entry point → its DSH-canonical counterpart + disposition |

### Why the projection is not a second authority

The old prototype's `ExecutionLedger` claimed to be the "canonical durable home of control-plane facts" — the exact contradiction the principal flagged. In this package, canonical control facts live in the DSH session log; `foldProjection` derives read models from that log alone. The fold never writes, and the runtime never persists derived state from memory. After a crash, a fresh runtime loads the persisted DSH log and rebuilds the projection; the delete-and-rebuild independence proof lives in `tests/projection.spec.ts`.

### Fencing and migration

The runtime obtains its writer token from the session's durable epoch (`ownershipEpochOf`) plus its own worker id. `appendFenced` carries the A2 in-transaction epoch assert: a stale writer is rejected before any event row commits. `migrateOwnership` uses `advanceOwnershipEpoch` CAS — the store's atomic `UPDATE ... WHERE ownership_epoch = ?` — so two processes racing to claim a session cannot both win. The migration fact is deliberately NOT logged as an event.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Session persistence event catalog](../../../docs/persistence-catalog.md) — the generated vocabulary: every `SessionEventMap` member with its payload and surface badge.
- [Persistence subsystem](../../../docs/subsystems/persistence.md) — how the log is made durable, fenced, and replayed.
- [Session subsystem](../../../docs/subsystems/session.md) — surface ordering, `deriveMessages()`, and the durable log contract.

-----

<a id="model-experience"></a>
## Model Experience

### Control-plane projection

#### What the model sees

Nothing. This package consumes log-only control events and never contributes to `deriveMessages()`, so the model's request context is byte-identical whether or not this package is mounted. The runtime only makes control-plane decisions durable and replayable; it never changes the conversation.

#### Token effect

None. The package never assembles a model request, so it adds no tokens to model requests.

#### KV Cache effect

None. The package never constructs provider requests, so it adds no KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit. They are current package constraints, not a task backlog.

- **Derived projection, not a second authority.** The SQLite projection this package conceptually replaces is disposable: delete it and rebuild from the DSH log. The DSH log is the only durable truth; the runtime itself writes no SQLite rows in this package's scope.
- **Real external-effect reconciliation protocols are deferred (P4+).** `reconcile()` resolves a prior `commit-unknown` through the worker with `reconcile: true`; production reconciliation protocols (external-state inspection, idempotency keys, saga compensation) are out of scope here.
- **The derived outbox is a working view, not durable.** `EffectExecutor.outbox()` folds the DSH log at call time; it is the dispatch resume point, never the source of truth.
- **No lifecycle events beyond the A1 vocabulary.** There is no `execution/settled` event. Settlement is DERIVED from canonical terminal facts: an execution is settled when every effect it requested reached a terminal derived outcome (`succeeded` / `failed` / `reconciled` / `denied`); an execution with a pending or ambiguous (`commit-unknown`) effect is NOT settled, and an execution that requested no effects is settled by construction. The fold never treats "the log currently ends here" as a terminal signal.
- **Live native sessions are excluded from runtime-owned sessions.** The runtime writes only through `appendFenced`; the live `Session` write-behind path is unfenced. In one backend, a live `Session` bound to a session the runtime already fenced-materialized is rejected (seed-mismatch id collision), so the two write modes cannot own one session id together. Any unfenced write that does land is still observed by the derived fold (digest/last-seq change), so a second-authority write cannot silently corrupt derived state.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the generated catalog.

#### Future: process-boundary delete/rebuild proof

`tests/projection.spec.ts` proves projection invariance in-package: build the DSH log via real `SessionPersistenceSqlite` on a temp DB file, fold, close and delete the derived SQLite, reopen, re-load from DSH, fold again, and assert both states are identical. The real process-boundary version (A4) separates the writer and the projector into distinct processes.

</details>
