/**
 * The typed capability kernel — the authority boundary of the derived
 * execution runtime. Core invariant: **text can request authority; text can
 * never confer authority.** The kernel evaluates effect proposals against
 * positive, scoped capabilities that are minted out-of-band (operator/host
 * configuration), never from model-visible content. Absence of a capability
 * means denial.
 *
 * @module @deepseek-ai/dsh-opencode-execution/capability
 */

/**
 * One typed capability: the deterministic grant the kernel consults. Only
 * out-of-band registrations can create one; untrusted text (prompt, tool
 * output, repository content, retrieved web text) never reaches this record.
 */
export interface Capability {
  /** The capability's stable id, recorded in `effect/authorized`. */
  readonly id: string
  /** The principal the capability names (`*` matches any proposer). */
  readonly principal: string
  /** The operation the capability authorizes (e.g. `fs.write`). */
  readonly operation: string
  /** Glob resource scope the capability authorizes (e.g. `fs:/srv/app/**`). */
  readonly resourceScope: string
  /** Effect classes the capability permits. */
  readonly effectClasses: readonly string[]
}

/**
 * One effect proposal the kernel evaluates. Every field is a typed request
 * fact; `payload` and provenance are advisory labels and never confer
 * authority.
 */
export interface EffectProposal {
  /** The execution that requested the effect. */
  readonly execution_id: string
  /** Stable logical action id (retries reuse it). */
  readonly action_id: string
  /** The concrete attempt id. */
  readonly attempt_id: string
  /** The mutation operation (create, write, execute, delete). */
  readonly operation: string
  /** The addressed resource path or name. */
  readonly resource: string
  /** The authority class that must decide the effect. */
  readonly effect_class: string
  /** The proposing principal (the model's session identity). */
  readonly proposer: string
  /** Serialized payload the effector consumes (never authority). */
  readonly payload?: unknown
}

/**
 * The kernel's deterministic decision for one proposal.
 */
export interface AuthorizationDecision {
  /** Whether a positive capability authorized the proposal. */
  readonly authorized: boolean
  /** The capability id that authorized it, when authorized. */
  readonly capability_id: string | null
  /** The action the decision names. */
  readonly action_id: string
  /** The human-readable reason the kernel recorded. */
  readonly reason: string
}

/**
 * The authority failure raised for malformed proposals and re-entry attempts.
 */
export class AuthorityError extends Error {
  /**
   * @param message - the failure detail.
   * @param code - the stable machine-readable failure code.
   */
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'AuthorityError'
  }
}

/**
 * Glob matcher for resource scopes (subset: `**`, `*`, exact, `dir/**`).
 * @param pattern - the capability's resource scope pattern.
 * @param resource - the proposal's addressed resource.
 * @returns whether the resource falls inside the scope pattern.
 */
export function resourceMatches(pattern: string, resource: string): boolean {
  if (pattern === resource) return true
  if (pattern === '**') return true
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3)
    return resource === prefix || resource.startsWith(prefix)
  }
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(resource)
  }
  return false
}

/**
 * Deterministic authority gate over typed capabilities. Absence of a matching
 * positive capability means denial; nothing in untrusted text can grant one.
 */
export class CapabilityKernel {
  private readonly capabilities = new Map<string, Capability>()

  /**
   * Register a capability out-of-band (operator/host only).
   * @param capability - the typed grant to add.
   */
  grant(capability: Capability): void {
    this.capabilities.set(capability.id, capability)
  }

  /**
   * Remove a previously registered capability.
   * @param capabilityId - the capability to revoke.
   */
  revoke(capabilityId: string): void {
    this.capabilities.delete(capabilityId)
  }

  /**
   * Authorize one effect proposal against the registered capabilities.
   * Deterministic: same inputs → same decision. Never reads untrusted text
   * for authority.
   * @param proposal - the typed effect proposal to evaluate.
   * @returns the kernel's authorization decision.
   */
  authorize(proposal: EffectProposal): AuthorizationDecision {
    for (const capability of this.capabilities.values()) {
      if (capability.principal !== proposal.proposer && capability.principal !== '*') continue
      if (capability.operation !== proposal.operation) continue
      if (!resourceMatches(capability.resourceScope, proposal.resource)) continue
      if (!capability.effectClasses.includes(proposal.effect_class)) continue
      return {
        authorized: true,
        capability_id: capability.id,
        action_id: proposal.action_id,
        reason: `capability ${capability.id} (${capability.operation} on ${capability.resourceScope})`,
      }
    }
    return {
      authorized: false,
      capability_id: null,
      action_id: proposal.action_id,
      reason: `no capability authorizes ${proposal.proposer} to ${proposal.operation} on ${proposal.resource} (class ${proposal.effect_class})`,
    }
  }
}
