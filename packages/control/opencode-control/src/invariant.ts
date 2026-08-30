/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-opencode-control`.
 * @module @deepseek-ai/dsh-opencode-control/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-opencode-control'

/** Cordis companion plugin name. */
export const name = 'opencode-control-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: these events are durable log-only facts whose
 * relationships (requested → authorized/denied → attempted → terminal, and
 * execution/commanded → activity/correlated) are owned by the opencode
 * control surface and verified by its own round-trip and lifecycle tests;
 * the harness core treats declaration-merged events generically.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
