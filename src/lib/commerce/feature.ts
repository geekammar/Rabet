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
