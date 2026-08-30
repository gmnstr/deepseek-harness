/**
 * Wire-safe control-plane identifiers and the `SessionEventMap` merge that
 * records opencode-style control activity as durable, log-only session events.
 * Free of cordis/service imports so browser type chains can consume the
 * payload types without loading this package's Context augmentation.
 *
 * The events in this merge are deliberately NON-DUPLICATIVE: each one owns a
 * distinct fact (an execution was commanded, an activity was correlated, an
 * effect transitioned state) that the native opencode control surface emits
 * into the harness session log. They are log-only — never surface-eligible —
 * so `Session.deriveMessages()` and every transcript fold ignore them.
 *
 * @module @deepseek-ai/dsh-opencode-control/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * One commanded execution unit (a shell command, tool invocation, or agent
 * command an opencode control loop issued). A string brand; the control
 * surface owns the id space and the factory is the only producer.
 */
export type ExecutionId = Branded<'ExecutionId'>

/**
 * Brand a string as an {@link ExecutionId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ExecutionId(id: string): ExecutionId {
  return id as ExecutionId
}

/**
 * One requested effect on a resource (a mutation the control plane asked an
 * authority to permit). A string brand; the requesting side owns the id space.
 */
export type ActionId = Branded<'ActionId'>

/**
 * Brand a string as an {@link ActionId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ActionId(id: string): ActionId {
  return id as ActionId
}

/**
 * One attempt at executing an authorized effect. A string brand; each
 * `effect/attempt-started` minted a fresh attempt id, and every later attempt
 * event for the same effect references it.
 */
export type AttemptId = Branded<'AttemptId'>

/**
 * Brand a string as an {@link AttemptId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function AttemptId(id: string): AttemptId {
  return id as AttemptId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * An execution unit was commanded by the control surface — the durable
     * record that a command string was issued under an execution id, and the
     * source (surface, automation, hook) that commanded it. `source` tells
     * the command's provenance apart from ordinary model-visible tool calls.
     */
    'execution/commanded': {
      version: 1
      execution_id: ExecutionId
      command: string
      source: string
    }
    /**
     * A native (non-harness) activity event was correlated to an execution:
     * the control surface observed a native event sequence number under an
     * execution id and tagged it with a kind so a consumer can reconstruct
     * the native stream in order. Log-only; never part of derived history.
     */
    'activity/correlated': {
      version: 1
      execution_id: ExecutionId
      native_event_seq: number
      kind: string
    }
    /**
     * An effect on a resource was requested — the earliest point the control
     * plane records intent to mutate. `operation` names the mutation (create,
     * write, execute, delete), `resource` the addressed path/name, and
     * `effect_class` the authority class that must decide it (approval,
     * sandbox, filesystem policy). A matching `effect/authorized` or
     * `effect/denied` always follows.
     */
    'effect/requested': {
      version: 1
      execution_id: ExecutionId
      action_id: ActionId
      operation: string
      resource: string
      effect_class: string
    }
    /**
     * An authority granted the requested effect: the capability id that
     * authorized the action. Pairs with the prior `effect/requested` of the
     * same `action_id`; an attempt may then start.
     */
    'effect/authorized': {
      version: 1
      execution_id: ExecutionId
      action_id: ActionId
      capability_id: string
    }
    /**
     * An authority refused the requested effect — the durable denial record.
     * `reason` is the authority's human-readable refusal, which stays
     * reproducible on replay without re-asking the authority.
     */
    'effect/denied': {
      version: 1
      execution_id: ExecutionId
      action_id: ActionId
      reason: string
    }
    /**
     * Execution of an authorized effect began as attempt `attempt_id` — the
     * transition from decision to action. Exactly one per attempt; the
     * attempt then reaches one of the terminal outcome events.
     */
    'effect/attempt-started': {
      version: 1
      execution_id: ExecutionId
      action_id: ActionId
      attempt_id: AttemptId
    }
    /**
     * The attempt completed successfully. `receipt` is the opaque outcome
     * payload the effect produced (result value, written path, exit code
     * envelope); the producer owns its JSON shape.
     */
    'effect/succeeded': {
      version: 1
      execution_id: ExecutionId
      action_id: ActionId
      attempt_id: AttemptId
      receipt: unknown
    }
    /**
     * The attempt failed. `error` is the stable machine-readable failure
     * string, kept in the log so replay can reproduce the failure without
     * re-executing the effect.
     */
    'effect/failed': {
      version: 1
      execution_id: ExecutionId
      action_id: ActionId
      attempt_id: AttemptId
      error: string
    }
    /**
     * The attempt's outcome is unknown at recording time — the executor
     * disconnected or lost the result (process killed, transport dropped).
     * A later `effect/reconciled` (same attempt) may resolve the ambiguity.
     */
    'effect/commit-unknown': {
      version: 1
      execution_id: ExecutionId
      action_id: ActionId
      attempt_id: AttemptId
    }
    /**
     * An earlier `effect/commit-unknown` attempt was reconciled to a definite
     * outcome after the fact: `receipt` carries the recovered outcome payload,
     * so the log converges to one terminal fact per attempt.
     */
    'effect/reconciled': {
      version: 1
      execution_id: ExecutionId
      action_id: ActionId
      attempt_id: AttemptId
      receipt: unknown
    }
  }
}
