import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/storefront", () => ({
  saveStorefrontMenuAction: vi.fn(),
  resetStorefrontMenuAction: vi.fn(),
}));

const { StorefrontSettingsManager } = await import(
  "@/components/dashboard/storefront/storefront-settings-manager"
);
const { defaultStorefrontMenuConfig } = await import("@/lib/storefront/menu");

describe("storefront settings dashboard", () => {
  it("renders all five default entries, statuses and a read-only preview", () => {
    const html = renderToStaticMarkup(
      createElement(StorefrontSettingsManager, {
        savedConfig: defaultStorefrontMenuConfig(),
        configSource: "default",
        displayName: "Preview Store",
        defaultLanguageCode: "en",
        enabledLanguages: [
          { code: "en", label: "English", isRtl: false },
          { code: "ar", label: "العربية", isRtl: true },
        ],
        visibility: {
          hasEligibleProducts: false,
          enabledLanguageCount: 2,
        },
        welcomeMessages: {
          en: "Welcome to Preview Store!",
          ar: "مرحبًا بك في Preview Store!",
        },
      }),
    );

    expect(html).toContain('data-testid="storefront-settings"');
    for (const key of ["products", "categories", "support", "languages", "inquiries"]) {
      expect(html).toContain(`data-testid="storefront-menu-toggle-${key}"`);
      expect(html).toContain(`data-testid="storefront-menu-item-${key}"`);
    }
    expect(html).toContain("5 of 5 entries enabled");
    expect(html).toContain("No eligible products are available yet.");
    expect(html).toContain("Visible to customers");
    expect(html).toContain("Temporarily unavailable");
    expect(html).toContain("Welcome to Preview Store!");
    expect(html).toContain("No Telegram message is sent");
    expect(html).toContain('data-testid="storefront-save-btn"');
    expect(html).toContain('data-testid="storefront-reset-btn"');
    expect(html).not.toContain('data-testid="storefront-preview-draft"');
  });

  it("uses localized labels in the preview and keeps touch targets", () => {
    const html = renderToStaticMarkup(
      createElement(StorefrontSettingsManager, {
        savedConfig: defaultStorefrontMenuConfig(),
        configSource: "saved",
        displayName: "Preview Store",
        defaultLanguageCode: "ar",
        enabledLanguages: [{ code: "ar", label: "العربية", isRtl: true }],
        visibility: {
          hasEligibleProducts: true,
          enabledLanguageCount: 1,
        },
        welcomeMessages: {
          ar: "مرحبًا بك في Preview Store!",
        },
      }),
    );

    expect(html).toContain("تصفح المنتجات");
    expect(html).toContain("تغيير اللغة");
    expect(html).toContain("Only one language is enabled");
    expect(html).toContain("min-h-11");
    expect(html).toContain("overflow-x-clip");
  });
});
