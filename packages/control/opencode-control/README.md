---
description: "Control-plane execution and effect audit events for the DeepSeek Harness session log: durable log-only records of commanded executions, correlated native activity, and the requested/authorized/denied/attempted/terminal effect lifecycle, for maintainers composing control surfaces or debugging effect authority."
kind: "package-reference"
---

# @deepseek-ai/dsh-opencode-control

English | [中文](README.zh.md)

## Summary

`dsh-opencode-control` contributes a small, non-duplicative set of control-plane events to the merge-extensible `SessionEventMap`: durable log-only records of what an opencode-style control surface commanded, how native activity correlates to an execution, and how each requested effect moved through authorize/deny/attempt/terminal states. Every event is a `version: 1` payload over branded ids, built by typed factory functions so producers cannot drift from the merged vocabulary. The events are deliberately log-only — they never join the LLM message surface, so `Session.deriveMessages()` and every transcript fold ignore them, while persistence, replay, and resume reconstruction keep them losslessly.

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

Use this package when a control surface (an automation loop, a hook bridge, an agent command runner) must record what it commanded and how the harness authorized and executed effects, inside the same durable session log that already carries the model transcript. Each event appends through the ordinary `Session.append` path, so durability, replay, resume, and the fail-closed read path come from the session subsystem unchanged.

### What it adds

The vocabulary is ten events across three scopes:

- **`execution/*`** — `execution/commanded` records that one execution unit was commanded, with its command string and provenance; `activity/correlated` records a native (non-harness) event observed under an execution id.
- **`effect/*` lifecycle** — `effect/requested` opens an effect request naming the operation, resource, and authority class; `effect/authorized` and `effect/denied` record the authority decision; `effect/attempt-started` opens an attempt; `effect/succeeded`, `effect/failed`, and `effect/commit-unknown` close it; `effect/reconciled` resolves an unknown attempt to a definite outcome later.

Every payload carries a `version` field and branded ids (`ExecutionId`, `ActionId`, `AttemptId`), so a log written by a newer producer shape stays identifiable at the type level.

### Building payloads

Producers import the typed factories from the package root and append the result through their own `Session`:

```ts
import { Session } from '@deepseek-ai/dsh-session'
import { ExecutionId, effectRequested } from '@deepseek-ai/dsh-opencode-control'

const execution = ExecutionId('exec-1')
session.append('effect/requested', effectRequested({
  execution_id: execution,
  action_id: ActionId('act-1'),
  operation: 'write',
  resource: '/workspace/notes.md',
  effect_class: 'filesystem',
}))
```

The factory return type is the exact `SessionEventMap` data of the event type, so a wrong field shape fails at compile time before it can reach the durable log.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable contract is covered in [Use this package](#use-this-package); this section explains how the merge, the catalog, and the read path cooperate.

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | The one home of the branded ids and the `SessionEventMap` declaration merge |
| [`src/index.ts`](src/index.ts) | Typed payload factories (`DshControlPayload` and each `effect*`/`execution*` builder) |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: no in-process relation to observe (round-trip and lifecycle tests own the checks) |

### The declaration merge and the generator

The ten events are declared inside `declare module '@deepseek-ai/dsh-session/types'`, exactly like every other plugin-owned session event. The `gen-persistence-catalog` generator scans `packages/*/*/src/**/*.ts` for `SessionEventMap` merges, requires each member to carry full JSDoc, and regenerates `KNOWN_SESSION_EVENT_TYPES` plus `docs/persistence-catalog.md`; this package is picked up by that scan automatically through the workspace glob.

### Why log-only

Each control event names a fact the native control surface owns and the harness did not previously record. Because none of them is a `SurfaceEventType` member, `Session.append` accepts them without a `SurfaceIntent` options tuple, `deriveMessages()` never projects them, and the surface fold stays identical to a session that never mounted this package. Persistence stores them like any other event, and the fail-closed read path (`KNOWN_SESSION_EVENT_TYPES`) refuses a log whose type this build does not know.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Session persistence event catalog](../../../docs/persistence-catalog.md) — the generated vocabulary: every `SessionEventMap` member with its payload and surface badge.
- [Session subsystem](../../../docs/subsystems/session.md) — surface ordering, `deriveMessages()`, and the durable log contract.
- [Persistence subsystem](../../../docs/subsystems/persistence.md) — how the log is made durable and replayed.

-----

<a id="model-experience"></a>
## Model Experience

### What the model sees

Nothing. Every control event is log-only: it never contributes to `deriveMessages()`, so the model's request context is byte-identical whether or not this package is mounted. The events exist to make the control plane's decisions durable and replayable, not to change the conversation.

### Token and KV-cache effect

None. Because the events never join the derived message history, they add no tokens to model requests and no KV-cache entries.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These limits define when the package is a poor fit. They are current package constraints, not a task backlog.

- **Vocabulary only — no policy.** This package records facts; it does not authorize, execute, or reconcile effects. The control surface that emits the events owns those transitions, and the harness core treats the events generically.
- **Out-of-repo consumers are not registered.** The generated `KNOWN_SESSION_EVENT_TYPES` lists only the events declared in this repository; a downstream producer package that merges its own event types would need its own registration surface, which the session subsystem has deferred.
- **No versioned migration.** Each payload pins `version: 1` as a type-level marker; there is no runtime migration table, and pre-release `SESSION_FORMAT_VERSION` makes no compatibility promise.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the generated catalog.

#### Future: consumption surfaces

The current merge is producer-only: it makes the events appendable, durable, and replayable, but no consumer projects them yet. A future consumer (a control-plane dashboard, a replay analysis tool, or a policy evaluator) would fold `execution/*` and `effect/*` events into its own projection, following the `session-projection` pattern used by `todo/write` and the permission knobs. No design exists yet.

</details>
