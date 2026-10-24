/**
 * Constants and operational safeguards for product interaction actions (ADR-014, DATA_MODEL.md §11.3).
 *
 * Operational safeguards:
 * - ACTION_DEPTH_WARNING_THRESHOLD = 8 levels (advisory in tree editor)
 * - MAX_ACTION_DEPTH = 16 levels (hard refusal in application/editor)
 * - MAX_ACTIVE_CHILDREN = 20 buttons per submenu / root (bounds Telegram menu size)
 * - MAX_ACTION_DEPTH_SAFEGUARD = 64 hops (cycle detection and traversal safety ceiling)
 *
 * Text length contracts:
 * - MAX_ACTION_LABEL_LENGTH = 64 chars (database check & Telegram button limit)
 * - MAX_ACTION_MENU_TEXT_LENGTH = 4096 chars (Telegram message text limit)
 * - MAX_ACTION_TEMPLATE_BODY_LENGTH = 4096 chars (Telegram message text limit)
 */

export const SUPPORTED_ACTION_TYPES = [
  "OPEN_SUBMENU",
  "SHOW_DETAILS",
  "START_INQUIRY",
  "SEND_TEMPLATE_MESSAGE",
  "OPEN_URL",
  "OPEN_SUPPORT",
  "NAVIGATE_CATALOG",
] as const;

export type SupportedActionType = (typeof SUPPORTED_ACTION_TYPES)[number];

export const DEFERRED_ACTION_TYPES = [] as const;

export type DeferredActionType = (typeof DEFERRED_ACTION_TYPES)[number];

export const MAX_ACTION_LABEL_LENGTH = 64;
export const MAX_ACTION_MENU_TEXT_LENGTH = 4096;
export const MAX_ACTION_TEMPLATE_BODY_LENGTH = 4096;

/** Advisory warning in editor when hierarchy depth exceeds this value. */
export const ACTION_DEPTH_WARNING_THRESHOLD = 8;

/** Hard stop limit on maximum hierarchy depth (root = level 1). */
export const MAX_ACTION_DEPTH = 16;

/** Maximum number of active buttons per submenu or root list. */
export const MAX_ACTIVE_CHILDREN = 20;

/** Safety bound for ancestry traversal and cycle detection. */
export const MAX_ACTION_DEPTH_SAFEGUARD = 64;

/** Supported placeholders for per-action template messages. */
export const ACTION_MESSAGE_PLACEHOLDERS = [
  "store_name",
  "product_name",
  "customer_name",
  "price",
] as const;

export type ActionMessagePlaceholder = (typeof ACTION_MESSAGE_PLACEHOLDERS)[number];

/** Default sample values for live action message preview. */
export const DEFAULT_ACTION_SAMPLE_CONTEXT: Record<ActionMessagePlaceholder, string> = {
  store_name: "Acme Digital",
  product_name: "Premium Package",
  customer_name: "Sarah Ahmed",
  price: "USD 99.00",
} as const;
