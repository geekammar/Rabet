import { z } from "zod";

/**
 * Storefront menu configuration.
 *
 * The five customer-facing entry points introduced in Phase 28 are merchant
 * configuration choices from Phase 29B onward. The configuration is a small,
 * ordered array stored on the settings singleton. There is deliberately no
 * second hierarchy, no generalized page builder and no tenant abstraction:
 * these are fixed product capabilities whose order and enabled state may vary.
 *
 * Backward compatibility is the default: a missing or null stored value means
 * "all five enabled in the Phase 28 order". Only an explicit merchant save
 * changes that behaviour.
 */

export const STOREFRONT_MENU_KEYS = [
  "products",
  "categories",
  "support",
  "languages",
  "inquiries",
] as const;

export type StorefrontMenuItemKey = (typeof STOREFRONT_MENU_KEYS)[number];

export interface StorefrontMenuItem {
  key: StorefrontMenuItemKey;
  enabled: boolean;
}

export interface StorefrontMenuConfig {
  version: 1;
  items: StorefrontMenuItem[];
}

export type StorefrontMenuConfigSource = "default" | "saved" | "invalid";

const storefrontMenuItems = z
  .array(
    z.object({
      key: z.enum(STOREFRONT_MENU_KEYS),
      enabled: z.boolean(),
    }),
  )
  .min(STOREFRONT_MENU_KEYS.length, "The menu configuration is incomplete.")
  .max(STOREFRONT_MENU_KEYS.length, "The menu configuration contains extra items.");

export const storefrontMenuConfigSchema = z
  .object({
    version: z.literal(1),
    items: storefrontMenuItems,
  })
  .superRefine((value, context) => {
    const seen = new Set<StorefrontMenuItemKey>();

    for (const item of value.items) {
      if (seen.has(item.key)) {
        context.addIssue({
          code: "custom",
          path: ["items"],
          message: "Each storefront menu item may appear only once.",
        });
        return;
      }
      seen.add(item.key);
    }

    if (seen.size !== STOREFRONT_MENU_KEYS.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "The menu configuration must include every default menu item.",
      });
      return;
    }

    if (!value.items.some((item) => item.enabled)) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message:
          "Keep at least one storefront menu item enabled so customers retain navigation.",
      });
    }
  });

export function defaultStorefrontMenuConfig(): StorefrontMenuConfig {
  return {
    version: 1,
    items: STOREFRONT_MENU_KEYS.map((key) => ({ key, enabled: true })),
  };
}

/**
 * Resolves a stored value into a usable configuration.
 *
 * `null`/`undefined` means the store has never customized its menu, so the
 * Phase 28 defaults apply. Malformed stored JSON also falls back to the
 * defaults rather than breaking the customer home; the dashboard separately
 * reports when the persisted value was not valid.
 */
export function resolveStorefrontMenuConfig(raw: unknown): {
  config: StorefrontMenuConfig;
  source: StorefrontMenuConfigSource;
} {
  if (raw === null || raw === undefined) {
    return { config: defaultStorefrontMenuConfig(), source: "default" };
  }

  const parsed = storefrontMenuConfigSchema.safeParse(raw);

  if (!parsed.success) {
    return { config: defaultStorefrontMenuConfig(), source: "invalid" };
  }

  return { config: parsed.data, source: "saved" };
}

export interface StorefrontMenuVisibility {
  hasEligibleProducts: boolean;
  enabledLanguageCount: number;
}

export type StorefrontMenuItemAvailability =
  | { available: true }
  | {
      available: false;
      reason: "no_products" | "single_language";
    };

/**
 * The existing Phase 28 eligibility rules, expressed for the preview and the
 * live renderer from one place.
 *
 * - Products are always offered; an empty catalog renders its own empty state.
 * - Categories are offered only when at least one eligible product exists.
 * - Support and inquiries are always safe.
 * - Language switching is offered only when two or more languages are enabled.
 */
export function getStorefrontMenuItemAvailability(
  key: StorefrontMenuItemKey,
  visibility: StorefrontMenuVisibility,
): StorefrontMenuItemAvailability {
  if (key === "categories" && !visibility.hasEligibleProducts) {
    return { available: false, reason: "no_products" };
  }

  if (key === "languages" && visibility.enabledLanguageCount < 2) {
    return { available: false, reason: "single_language" };
  }

  return { available: true };
}

export function isStorefrontMenuItemAvailable(
  key: StorefrontMenuItemKey,
  visibility: StorefrontMenuVisibility,
): boolean {
  return getStorefrontMenuItemAvailability(key, visibility).available;
}

export function getVisibleStorefrontMenuItems(
  config: StorefrontMenuConfig,
  visibility: StorefrontMenuVisibility,
): StorefrontMenuItem[] {
  return config.items.filter(
    (item) => item.enabled && isStorefrontMenuItemAvailable(item.key, visibility),
  );
}

export interface ResolvedStorefrontMenuButtons {
  items: StorefrontMenuItem[];
  fallbackUsed: boolean;
}

/**
 * The single resolution used by both the live Telegram home and the dashboard
 * customer preview.
 *
 * It returns only the buttons that are actually rendered, in configured order,
 * and supplies the documented Contact Support fallback when configuration plus
 * contextual eligibility leave no visible entry. Keeping this shared prevents
 * the preview from drifting into a different interpretation of the menu.
 */
export function resolveStorefrontMenuButtons(
  config: StorefrontMenuConfig,
  visibility: StorefrontMenuVisibility,
): ResolvedStorefrontMenuButtons {
  const visibleItems = getVisibleStorefrontMenuItems(config, visibility);

  if (visibleItems.length > 0) {
    return { items: visibleItems, fallbackUsed: false };
  }

  return {
    items: [{ key: "support", enabled: true }],
    fallbackUsed: true,
  };
}

export function availabilityReasonLabel(
  reason: "no_products" | "single_language",
): string {
  if (reason === "no_products") {
    return "No eligible products are available yet.";
  }

  return "Only one language is enabled, so no language switch is needed.";
}

export const STOREFRONT_MENU_LABELS = {
  en: {
    products: "🛍 Browse Products",
    categories: "🗂 Browse Categories",
    support: "💬 Contact Support",
    languages: "🌐 Change Language",
    inquiries: "📨 My Active Inquiries",
  },
  ar: {
    products: "🛍 تصفح المنتجات",
    categories: "🗂 تصفح الأقسام",
    support: "💬 تواصل مع الدعم",
    languages: "🌐 تغيير اللغة",
    inquiries: "📨 استفساراتي النشطة",
  },
} as const satisfies Record<"en" | "ar", Record<StorefrontMenuItemKey, string>>;

export function getStorefrontMenuButtonLabels(
  isRtl: boolean,
): Record<StorefrontMenuItemKey, string> {
  return isRtl ? STOREFRONT_MENU_LABELS.ar : STOREFRONT_MENU_LABELS.en;
}
