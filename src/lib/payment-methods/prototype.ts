import "server-only";

/**
 * The manual-payment customer journey is a synthetic prototype.
 *
 * It is disabled by default, independently of whether central payment methods
 * and product buttons are configured, because configuring a method is not a
 * payment and activating one is not a channel launch decision.
 *
 * Only an isolated non-production test deployment should set this variable.
 * It must never be set in Vercel Production.
 */
export const MANUAL_PAYMENT_PROTOTYPE_ENV = "MANUAL_PAYMENT_PROTOTYPE_ENABLED";

export function isManualPaymentPrototypeEnabled(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): boolean {
  return env[MANUAL_PAYMENT_PROTOTYPE_ENV] === "true";
}
