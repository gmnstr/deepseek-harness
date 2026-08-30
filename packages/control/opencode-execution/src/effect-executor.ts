/**
 * Effect safety on real DSH backing. The executor is the ONLY effectful entry
 * point: structural validation → capability authorize (typed out-of-band
 * capabilities only — text can never confer authority) → canonical
 * `effect/requested` + `effect/authorized`/`effect/denied` via the runtime →
 * outbox working view DERIVED from the DSH log (fold of `effect/*` events) →
 * scoped worker execute with retries (each retry = a new canonical
 * `effect/attempt-started` with distinct attempt id) → outcome appended
 * canonically.
 *
 * `commit-unknown` breaks the loop: an ambiguous irreversible effect is never
 * blind-retried. A dedicated `reconcile()` resolves only `commit-unknown`
 * actions with a distinct `${action_id}:reconcile:1` attempt and
 * `reconcile: true` to the worker. A second `execute()` for an action already
 * in succeeded/reconciled/commit-unknown is rejected (ERR_EFFECT_REENTRY).
 *
 * The outbox is a DERIVED working view, not durable: the durable truth is the
 * DSH log.
 *
 * @module @deepseek-ai/dsh-opencode-execution/effect-executor
 */

import type {
  ActionId,
  AttemptId,
  ExecutionId,
} from '@deepseek-ai/dsh-opencode-control'
import { ExecutionId as brandExecutionId } from '@deepseek-ai/dsh-opencode-control'
import type { DerivedEffect } from './types.ts'
import { AuthorityError, CapabilityKernel, type EffectProposal } from './capability.ts'
import type { ExecutionRuntime } from './execution-runtime.ts'

/** One terminal outcome an effect worker reports. */
export type EffectOutcome =
  | { kind: 'succeeded'; receipt: unknown }
  | { kind: 'failed'; error: string }
  /** Request sent, mutation may have succeeded, response lost — never blind-retry. */
  | { kind: 'commit-unknown' }
  /** External state checked, earlier commit confirmed. */
  | { kind: 'reconciled'; receipt: unknown }

/** The canonical result record of one effect execution. */
export interface EffectResult {
  /** Stable logical action id (retries reuse it). */
  readonly action_id: ActionId
  /** The final concrete attempt id. */
  readonly attempt_id: AttemptId
  /** The terminal outcome of the final attempt. */
  readonly outcome: EffectOutcome
}

/** A scoped effect worker: executes ONE effect operation with narrow credentials. */
export interface EffectWorker {
  /** The operation this worker executes. */
  readonly operation: string
  /**
   * Execute one attempt. When `reconcile` is true the caller is NOT requesting
   * a fresh mutation dispatch — it is probing the external system to resolve a
   * prior `commit-unknown`; a correct worker for an IRREVERSIBLE effect must
   * CHECK external state (and return succeeded/reconciled/failed) rather than
   * re-apply the mutation.
   */
  execute(attempt: {
    action_id: string
    attempt_id: string
    resource: string
    payload: unknown
    reconcile?: boolean
  }): Promise<EffectOutcome>
}

/** One derived outbox record — a working view, never durable truth. */
export interface OutboxRecord {
  /** The logical action this record tracks. */
  readonly action_id: ActionId
  /** The latest concrete attempt id. */
  readonly attempt_id: AttemptId
  /** The execution that requested the effect. */
  readonly execution_id: ExecutionId
  /** The mutation operation. */
  readonly operation: string
  /** The addressed resource path or name. */
  readonly resource: string
  /** The authority class that must decide the effect. */
  readonly effect_class: string
  /** The capability id that authorized the effect. */
  readonly capability_id: string | null
  /** The derived working state. */
  readonly state: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'commit-unknown' | 'reconciled'
}

/** Options for the effect executor. */
export interface EffectExecutorOptions {
  /** The serialized runtime that owns canonical writes. */
  readonly runtime: ExecutionRuntime
  /** The typed authority kernel. */
  readonly kernel: CapabilityKernel
  /** Workers keyed by operation name. */
  readonly workers: ReadonlyMap<string, EffectWorker>
  /** Default retry bound for failed (non-ambiguous) attempts. */
  readonly maxAttempts?: number
}

/** The outcome of one `execute` or `reconcile` call. */
export interface EffectExecOutcome {
  /** The canonical result record, or null when the proposal was denied. */
  readonly result: EffectResult | null
  /** The decision the kernel recorded. */
  readonly decision: { authorized: boolean; capability_id: string | null; action_id: string; reason: string }
}

/** Reconstruct the derived outbox working view from one derived effect. */
function outboxRecord(effect: DerivedEffect): OutboxRecord {
  const attempt_id = effect.attempt_ids.at(-1)
  const state: OutboxRecord['state'] = (() => {
    switch (effect.outcome) {
      case 'requested':
      case 'authorized':
      case 'attempt-started':
        return 'dispatched'
      case 'none':
      case 'denied':
        return 'queued'
      default:
        return effect.outcome
    }
  })()
  return {
    action_id: effect.action_id,
    attempt_id: attempt_id ?? (effect.action_id as unknown as AttemptId),
    execution_id: effect.execution_id,
    operation: effect.operation,
    resource: effect.resource,
    effect_class: effect.effect_class,
    capability_id: effect.capability_id ?? null,
    state,
  }
}

/**
 * Effect executor: kernel-gated effect dispatch over the canonical DSH log.
 */
export class EffectExecutor {
  private readonly runtime: ExecutionRuntime
  private readonly kernel: CapabilityKernel
  private readonly workers: ReadonlyMap<string, EffectWorker>
  private readonly maxAttempts: number

  /**
   * @param options - runtime, kernel, workers, and retry bound.
   */
  constructor(options: EffectExecutorOptions) {
    this.runtime = options.runtime
    this.kernel = options.kernel
    this.workers = options.workers
    this.maxAttempts = options.maxAttempts ?? 3
  }

  /**
   * The derived outbox working view, reconstructed from the DSH log. Not
   * durable — the durable truth is the log; this is only the dispatch resume
   * point after authorization.
   * @returns every derived outbox record in effect-request order.
   */
  async outbox(): Promise<readonly OutboxRecord[]> {
    const derived = await this.runtime.derive()
    return [...derived.effects.values()].map(outboxRecord)
  }

  /**
   * Execute one effect end-to-end: structural validation → kernel authorize →
   * canonical `effect/requested` + `effect/authorized`/`effect/denied` →
   * worker execute with retries (each retry appends a distinct
   * `effect/attempt-started`) → canonical outcome. `commit-unknown` breaks the
   * loop; never blind-retries an ambiguous irreversible effect.
   * @param proposal - the typed effect proposal (identity + operation/resource
   *   + typed class; payload/provenance are advisory only).
   * @returns the canonical result and the kernel decision.
   */
  async execute(proposal: EffectProposal): Promise<EffectExecOutcome> {
    if (!proposal.action_id || !proposal.attempt_id || !proposal.operation || !proposal.resource) {
      throw new AuthorityError('malformed effect proposal: missing identity/operation/resource', 'ERR_MALFORMED')
    }

    const decision = this.kernel.authorize(proposal)
    if (!decision.authorized) {
      await this.runtime.requestEffect(
        brandExecutionId(proposal.execution_id),
        proposal.action_id as ActionId,
        proposal.operation,
        proposal.resource,
        proposal.effect_class,
      )
      await this.runtime.denyEffect(
        brandExecutionId(proposal.execution_id),
        proposal.action_id as ActionId,
        decision.reason,
      )
      return { result: null, decision }
    }

    await this.assertReentry(proposal.action_id as ActionId)

    await this.runtime.requestEffect(
      brandExecutionId(proposal.execution_id),
      proposal.action_id as ActionId,
      proposal.operation,
      proposal.resource,
      proposal.effect_class,
    )
    await this.runtime.authorizeEffect(
      brandExecutionId(proposal.execution_id),
      proposal.action_id as ActionId,
      decision.capability_id as string,
    )

    const worker = this.workers.get(proposal.operation)
    if (worker === undefined) {
      const attemptId = proposal.attempt_id as AttemptId
      await this.runtime.startAttempt(
        brandExecutionId(proposal.execution_id),
        proposal.action_id as ActionId,
        attemptId,
      )
      await this.runtime.failEffect(
        brandExecutionId(proposal.execution_id),
        proposal.action_id as ActionId,
        attemptId,
        `no effector for operation ${proposal.operation}`,
      )
      return {
        result: {
          action_id: proposal.action_id as ActionId,
          attempt_id: attemptId,
          outcome: { kind: 'failed', error: `no effector for operation ${proposal.operation}` },
        },
        decision,
      }
    }

    let attempt = 1
    let outcome: EffectOutcome | null = null
    let finalAttemptId: AttemptId = proposal.attempt_id as AttemptId
    while (attempt <= this.maxAttempts) {
      const attemptId = attempt === 1 ? proposal.attempt_id as AttemptId : `${proposal.action_id}:retry:${attempt}` as AttemptId
      finalAttemptId = attemptId
      await this.runtime.startAttempt(
        brandExecutionId(proposal.execution_id),
        proposal.action_id as ActionId,
        attemptId,
      )
      const workerOutcome = await worker.execute({
        action_id: String(proposal.action_id),
        attempt_id: String(attemptId),
        resource: proposal.resource,
        payload: proposal.payload,
      })
      if (workerOutcome.kind === 'succeeded' || workerOutcome.kind === 'reconciled') {
        outcome = workerOutcome
        break
      }
      if (workerOutcome.kind === 'failed') {
        if (attempt < this.maxAttempts) {
          attempt += 1
          continue
        }
        outcome = { kind: 'failed', error: workerOutcome.error }
        break
      }
      // commit_unknown: NEVER blind-retry an ambiguous irreversible effect.
      outcome = { kind: 'commit-unknown' }
      break
    }

    const result: EffectResult = {
      action_id: proposal.action_id as ActionId,
      attempt_id: finalAttemptId,
      outcome: outcome ?? { kind: 'failed', error: 'max attempts exceeded' },
    }

    if (result.outcome.kind === 'succeeded') {
      await this.runtime.succeedEffect(
        brandExecutionId(proposal.execution_id),
        result.action_id,
        result.attempt_id,
        result.outcome.receipt,
      )
    } else if (result.outcome.kind === 'failed') {
      await this.runtime.failEffect(
        brandExecutionId(proposal.execution_id),
        result.action_id,
        result.attempt_id,
        result.outcome.error,
      )
    } else if (result.outcome.kind === 'commit-unknown') {
      await this.runtime.commitUnknown(
        brandExecutionId(proposal.execution_id),
        result.action_id,
        result.attempt_id,
      )
    } else {
      await this.runtime.reconcileEffect(
        brandExecutionId(proposal.execution_id),
        result.action_id,
        result.attempt_id,
        result.outcome.receipt,
      )
    }

    return { result, decision }
  }

  /**
   * Reconcile a prior `effect/commit-unknown` WITHOUT re-dispatching the
   * mutation as fresh. Only an action in `commit-unknown` may be reconciled;
   * the probe uses a distinct `${action_id}:reconcile:1` attempt id and passes
   * `reconcile: true` to the worker so an IRREVERSIBLE effector checks external
   * state instead of re-applying the mutation.
   * @param input - action id, resource, and probe payload.
   * @returns the canonical reconciliation result.
   */
  async reconcile(input: { action_id: string; resource: string; payload: unknown }): Promise<EffectExecOutcome> {
    const { action_id, resource, payload } = input
    if (!action_id || !resource) {
      throw new AuthorityError('malformed reconciliation request: missing action_id/resource', 'ERR_MALFORMED')
    }
    const actionId = action_id as ActionId
    const derived = await this.runtime.derive()
    const effect = derived.effects.get(actionId)
    if (effect === undefined || effect.outcome !== 'commit-unknown') {
      throw new AuthorityError(
        `reconcile for action ${action_id} in state ${effect?.outcome ?? '(none)'}: only an ambiguous (commit-unknown) action can be reconciled`,
        'ERR_RECONCILE_UNEXPECTED_STATE',
      )
    }

    const worker = this.workers.get(effect.operation)
    const attemptId = `${action_id}:reconcile:1` as AttemptId
    if (worker === undefined) {
      await this.runtime.startAttempt(effect.execution_id, actionId, attemptId)
      await this.runtime.failEffect(
        effect.execution_id,
        actionId,
        attemptId,
        `no effector for reconciliation of ${effect.operation}`,
      )
      return {
        result: {
          action_id: actionId,
          attempt_id: attemptId,
          outcome: { kind: 'failed', error: `no effector for reconciliation of ${effect.operation}` },
        },
        decision: { authorized: true, capability_id: effect.capability_id ?? null, action_id, reason: `reconciliation of previously authorized action ${action_id}` },
      }
    }

    await this.runtime.startAttempt(effect.execution_id, actionId, attemptId)
    const outcome = await worker.execute({
      action_id,
      attempt_id: String(attemptId),
      resource,
      payload,
      reconcile: true,
    })

    if (outcome.kind === 'succeeded' || outcome.kind === 'reconciled') {
      await this.runtime.reconcileEffect(effect.execution_id, actionId, attemptId, outcome.receipt)
      return {
        result: { action_id: actionId, attempt_id: attemptId, outcome },
        decision: { authorized: true, capability_id: effect.capability_id ?? null, action_id, reason: `reconciliation of previously authorized action ${action_id}` },
      }
    }
    if (outcome.kind === 'failed') {
      await this.runtime.failEffect(effect.execution_id, actionId, attemptId, outcome.error)
      return {
        result: { action_id: actionId, attempt_id: attemptId, outcome },
        decision: { authorized: true, capability_id: effect.capability_id ?? null, action_id, reason: `reconciliation of previously authorized action ${action_id}` },
      }
    }
    // Still ambiguous: the action stays unresolved; never re-applied.
    await this.runtime.commitUnknown(effect.execution_id, actionId, attemptId)
    return {
      result: { action_id: actionId, attempt_id: attemptId, outcome },
      decision: { authorized: true, capability_id: effect.capability_id ?? null, action_id, reason: `reconciliation of previously authorized action ${action_id}` },
    }
  }

  /**
   * FR-3-01 re-entry guard: a second execute() for an action already in
   * succeeded/reconciled/commit-unknown is rejected. The guard sits AFTER the
   * kernel check so a kernel denial for an already-terminal action is harmless.
   * @param actionId - the action being (re)dispatched.
   * @throws `AuthorityError` with code `ERR_EFFECT_REENTRY`.
   */
  private async assertReentry(actionId: ActionId): Promise<void> {
    const derived = await this.runtime.derive()
    const effect = derived.effects.get(actionId)
    if (effect === undefined) return
    if (effect.outcome === 'succeeded' || effect.outcome === 'reconciled' || effect.outcome === 'commit-unknown') {
      throw new AuthorityError(
        `effect re-entry for action ${actionId}: already reached ${effect.outcome}; reconcile an ambiguous action via reconcile() and never re-dispatch`,
        'ERR_EFFECT_REENTRY',
      )
    }
  }
}
