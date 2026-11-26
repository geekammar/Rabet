/**
 * Cash-on-delivery enablement.
 *
 * This is a deployment-level kill switch, not an authorization boundary. Both
 * this flag and the per-store `store_commerce_setting.cod_enabled` row must be
 * explicitly enabled before the managed bot shows any cart or checkout UI.
 * The flag is off by default and must never be set for a Production or pilot
 * target as part of the first slice.
 */
export const COD_ORDERS_ENABLED_ENV = "RABET_COD_ORDERS_ENABLED";

export function isCodOrdersDeploymentEnabled(): boolean {
  const raw = process.env[COD_ORDERS_ENABLED_ENV];
  return typeof raw === "string" && raw.trim().toLowerCase() === "true";
}

/**
 * Manual Vodafone Cash transfer enablement.
 *
 * Like the COD switch this is a deployment-level kill switch, not an
 * authorization boundary. A store must also set
 * `store_commerce_setting.vodafone_cash_enabled` before checkout offers the
 * method. Claims are reviewed by the merchant and never auto-verified.
 */
export const MANUAL_TRANSFER_ENABLED_ENV = "RABET_MANUAL_TRANSFER_ENABLED";

export function isManualTransferDeploymentEnabled(): boolean {
  const raw = process.env[MANUAL_TRANSFER_ENABLED_ENV];
  return typeof raw === "string" && raw.trim().toLowerCase() === "true";
}

/**
 * True when at least one checkout payment method is enabled for this
 * deployment. Cart and contact collection are shared by both methods, so the
 * order engine opens when either method is available; each confirmation still
 * checks its own method switch independently.
 */
export function isCommerceDeploymentEnabled(): boolean {
  return isCodOrdersDeploymentEnabled() || isManualTransferDeploymentEnabled();
}
