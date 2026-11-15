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
const { saveStorefrontMenuAction, resetStorefrontMenuAction } = await import(
  "@/app/actions/storefront"
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
    expect(html).toContain('data-testid="storefront-preview-button-products"');
    expect(html).toContain('data-testid="storefront-preview-button-support"');
    expect(html).toContain('data-testid="storefront-preview-button-languages"');
    expect(html).toContain('data-testid="storefront-preview-button-inquiries"');
    expect(html).not.toContain('data-testid="storefront-preview-button-categories"');
    expect(html.indexOf('data-testid="storefront-preview-button-products"')).toBeLessThan(
      html.indexOf('data-testid="storefront-preview-button-support"'),
    );
    expect(html.indexOf('data-testid="storefront-preview-button-support"')).toBeLessThan(
      html.indexOf('data-testid="storefront-preview-button-languages"'),
    );
    expect(html).toContain('data-testid="storefront-save-btn"');
    expect(html).toContain('data-testid="storefront-reset-btn"');
    expect(html).not.toContain('data-testid="storefront-preview-draft"');
    expect(saveStorefrontMenuAction).not.toHaveBeenCalled();
    expect(resetStorefrontMenuAction).not.toHaveBeenCalled();
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
    expect(html).toContain("تواصل مع الدعم");
    expect(html).toContain("استفساراتي النشطة");
    expect(html).not.toContain("تغيير اللغة");
    expect(html).toContain("Only one language is enabled");
    expect(html).toContain('data-testid="storefront-preview-button-products"');
    expect(html).not.toContain('data-testid="storefront-preview-button-languages"');
    expect(html).toContain("min-h-11");
    expect(html).toContain("overflow-x-clip");
  });

  it("renders only visible buttons and uses the support fallback when none are available", () => {
    const html = renderToStaticMarkup(
      createElement(StorefrontSettingsManager, {
        savedConfig: {
          version: 1,
          items: [
            { key: "products", enabled: false },
            { key: "categories", enabled: false },
            { key: "support", enabled: false },
            { key: "languages", enabled: true },
            { key: "inquiries", enabled: false },
          ],
        },
        configSource: "saved",
        displayName: "Preview Store",
        defaultLanguageCode: "en",
        enabledLanguages: [{ code: "en", label: "English", isRtl: false }],
        visibility: {
          hasEligibleProducts: false,
          enabledLanguageCount: 1,
        },
        welcomeMessages: {
          en: "Welcome to Preview Store!",
        },
      }),
    );

    expect(html).toContain('data-testid="storefront-preview-button-support"');
    expect(html).not.toContain('data-testid="storefront-preview-button-products"');
    expect(html).not.toContain('data-testid="storefront-preview-button-categories"');
    expect(html).not.toContain('data-testid="storefront-preview-button-languages"');
    expect(html).not.toContain('data-testid="storefront-preview-button-inquiries"');
    expect(html).toContain("Contact Support is");
    expect(html).toContain("shown as the safe navigation fallback");
  });

  it("shows disabled and contextual statuses only in the configuration list", () => {
    const html = renderToStaticMarkup(
      createElement(StorefrontSettingsManager, {
        savedConfig: {
          version: 1,
          items: [
            { key: "products", enabled: true },
            { key: "categories", enabled: true },
            { key: "support", enabled: true },
            { key: "languages", enabled: false },
            { key: "inquiries", enabled: true },
          ],
        },
        configSource: "saved",
        displayName: "Preview Store",
        defaultLanguageCode: "en",
        enabledLanguages: [{ code: "en", label: "English", isRtl: false }],
        visibility: {
          hasEligibleProducts: false,
          enabledLanguageCount: 1,
        },
        welcomeMessages: {
          en: "Welcome to Preview Store!",
        },
      }),
    );

    expect(html).toContain('data-testid="storefront-menu-item-languages"');
    expect(html).toContain('data-testid="storefront-menu-item-categories"');
    expect(html).toContain("Hidden in configuration");
    expect(html).toContain("Temporarily unavailable");
    expect(html).not.toContain('data-testid="storefront-preview-button-languages"');
    expect(html).not.toContain('data-testid="storefront-preview-button-categories"');
  });
});
