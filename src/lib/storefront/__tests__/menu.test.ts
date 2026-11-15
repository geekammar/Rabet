import { describe, expect, it } from "vitest";

import {
  STOREFRONT_MENU_KEYS,
  defaultStorefrontMenuConfig,
  getStorefrontMenuButtonLabels,
  getStorefrontMenuItemAvailability,
  getVisibleStorefrontMenuItems,
  resolveStorefrontMenuButtons,
  resolveStorefrontMenuConfig,
  storefrontMenuConfigSchema,
} from "../menu";

describe("storefront menu configuration", () => {
  it("keeps all five Phase 28 entries enabled in the default order", () => {
    const config = defaultStorefrontMenuConfig();

    expect(config.version).toBe(1);
    expect(config.items.map((item) => item.key)).toEqual([...STOREFRONT_MENU_KEYS]);
    expect(config.items.every((item) => item.enabled)).toBe(true);
  });

  it("treats a missing value as the backward-compatible default", () => {
    const resolved = resolveStorefrontMenuConfig(null);

    expect(resolved.source).toBe("default");
    expect(resolved.config).toEqual(defaultStorefrontMenuConfig());
  });

  it("keeps a valid saved order and enabled state", () => {
    const saved = {
      version: 1 as const,
      items: [
        { key: "support" as const, enabled: true },
        { key: "products" as const, enabled: false },
        { key: "categories" as const, enabled: true },
        { key: "languages" as const, enabled: true },
        { key: "inquiries" as const, enabled: true },
      ],
    };

    const resolved = resolveStorefrontMenuConfig(saved);

    expect(resolved.source).toBe("saved");
    expect(resolved.config.items[0]).toEqual({ key: "support", enabled: true });
    expect(resolved.config.items[1]).toEqual({ key: "products", enabled: false });
  });

  it("falls back to the defaults for malformed stored data", () => {
    const resolved = resolveStorefrontMenuConfig({
      version: 1,
      items: [{ key: "products", enabled: true }],
    });

    expect(resolved.source).toBe("invalid");
    expect(resolved.config).toEqual(defaultStorefrontMenuConfig());
  });

  it("rejects an all-disabled menu so customers always retain navigation", () => {
    const parsed = storefrontMenuConfigSchema.safeParse({
      version: 1,
      items: STOREFRONT_MENU_KEYS.map((key) => ({ key, enabled: false })),
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /at least one/i.test(issue.message))).toBe(
        true,
      );
    }
  });

  it("rejects duplicate or missing menu keys", () => {
    const duplicate = storefrontMenuConfigSchema.safeParse({
      version: 1,
      items: [
        { key: "products", enabled: true },
        { key: "products", enabled: true },
        { key: "support", enabled: true },
        { key: "languages", enabled: true },
        { key: "inquiries", enabled: true },
      ],
    });
    const missing = storefrontMenuConfigSchema.safeParse({
      version: 1,
      items: STOREFRONT_MENU_KEYS.filter((key) => key !== "categories").map(
        (key) => ({ key, enabled: true }),
      ).concat({ key: "products", enabled: true }),
    });

    expect(duplicate.success).toBe(false);
    expect(missing.success).toBe(false);
  });

  it("keeps the existing contextual eligibility rules", () => {
    const visibility = {
      hasEligibleProducts: false,
      enabledLanguageCount: 1,
    };

    expect(getStorefrontMenuItemAvailability("products", visibility)).toEqual({
      available: true,
    });
    expect(getStorefrontMenuItemAvailability("categories", visibility)).toEqual({
      available: false,
      reason: "no_products",
    });
    expect(getStorefrontMenuItemAvailability("languages", visibility)).toEqual({
      available: false,
      reason: "single_language",
    });
    expect(getStorefrontMenuItemAvailability("support", visibility)).toEqual({
      available: true,
    });
    expect(getStorefrontMenuItemAvailability("inquiries", visibility)).toEqual({
      available: true,
    });
  });

  it("filters disabled and contextually unavailable entries but keeps order", () => {
    const config = {
      version: 1 as const,
      items: [
        { key: "categories" as const, enabled: true },
        { key: "products" as const, enabled: false },
        { key: "support" as const, enabled: true },
        { key: "languages" as const, enabled: true },
        { key: "inquiries" as const, enabled: true },
      ],
    };

    const visible = getVisibleStorefrontMenuItems(config, {
      hasEligibleProducts: false,
      enabledLanguageCount: 2,
    });

    expect(visible.map((item) => item.key)).toEqual([
      "support",
      "languages",
      "inquiries",
    ]);
  });

  it("resolves the default five entries in order for customer rendering", () => {
    const resolved = resolveStorefrontMenuButtons(defaultStorefrontMenuConfig(), {
      hasEligibleProducts: true,
      enabledLanguageCount: 2,
    });

    expect(resolved.fallbackUsed).toBe(false);
    expect(resolved.items.map((item) => item.key)).toEqual([...STOREFRONT_MENU_KEYS]);
  });

  it("removes a disabled entry from customer rendering", () => {
    const resolved = resolveStorefrontMenuButtons(
      {
        version: 1,
        items: [
          { key: "products", enabled: false },
          { key: "categories", enabled: true },
          { key: "support", enabled: true },
          { key: "languages", enabled: true },
          { key: "inquiries", enabled: true },
        ],
      },
      { hasEligibleProducts: true, enabledLanguageCount: 2 },
    );

    expect(resolved.items.map((item) => item.key)).toEqual([
      "categories",
      "support",
      "languages",
      "inquiries",
    ]);
  });

  it("removes contextually unavailable categories and language switching", () => {
    const resolved = resolveStorefrontMenuButtons(defaultStorefrontMenuConfig(), {
      hasEligibleProducts: false,
      enabledLanguageCount: 1,
    });

    expect(resolved.items.map((item) => item.key)).toEqual([
      "products",
      "support",
      "inquiries",
    ]);
  });

  it("uses the support fallback when every configured entry is unavailable", () => {
    const resolved = resolveStorefrontMenuButtons(
      {
        version: 1,
        items: [
          { key: "categories", enabled: true },
          { key: "languages", enabled: true },
          { key: "products", enabled: false },
          { key: "support", enabled: false },
          { key: "inquiries", enabled: false },
        ],
      },
      { hasEligibleProducts: false, enabledLanguageCount: 1 },
    );

    expect(resolved.fallbackUsed).toBe(true);
    expect(resolved.items).toEqual([{ key: "support", enabled: true }]);
  });

  it("preserves configured order after filtering", () => {
    const resolved = resolveStorefrontMenuButtons(
      {
        version: 1,
        items: [
          { key: "inquiries", enabled: true },
          { key: "support", enabled: true },
          { key: "products", enabled: false },
          { key: "categories", enabled: true },
          { key: "languages", enabled: true },
        ],
      },
      { hasEligibleProducts: false, enabledLanguageCount: 2 },
    );

    expect(resolved.items.map((item) => item.key)).toEqual([
      "inquiries",
      "support",
      "languages",
    ]);
  });

  it("provides localized labels for both supported directions", () => {
    expect(getStorefrontMenuButtonLabels(false).products).toBe("🛍 Browse Products");
    expect(getStorefrontMenuButtonLabels(true).products).toBe("🛍 تصفح المنتجات");
    expect(getStorefrontMenuButtonLabels(true).categories).toBe("🗂 تصفح الأقسام");
  });
});
