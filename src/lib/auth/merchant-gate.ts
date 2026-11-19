/**
 * Merchant application enablement gate.
 *
 * Merchant pages, handlers and Server Actions call this before touching a
 * session, an invitation or the database. The gate is **off by default**: only
 * the exact value `true` (surrounding whitespace ignored) enables the surface.
 * A disposable test target may set it; production is expected not to.
 *
 * This is an enablement flag, not an authorization check. The authoritative
 * authorization checks remain the invitation transaction and
 * `requireMerchantScope()`.
 */
export const MERCHANT_APP_ENABLED_ENV = "RABET_MERCHANT_APP_ENABLED";

export function isMerchantAppEnabled(): boolean {
  const raw = process.env[MERCHANT_APP_ENABLED_ENV];
  return typeof raw === "string" && raw.trim().toLowerCase() === "true";
}
