import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", async () => {
  const React = await import("react");

  return {
    default: ({
      href,
      children,
      ...props
    }: {
      href: string;
      children?: React.ReactNode;
    }) => React.createElement("a", { href, ...props }, children),
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/overview",
}));

vi.mock("@/app/actions/payment-methods", () => ({
  createPaymentMethodAction: vi.fn(),
  updatePaymentMethodAction: vi.fn(),
  togglePaymentMethodActiveAction: vi.fn(),
  loadPaymentMethodsAction: vi.fn(),
}));

const { Sidebar } = await import("@/components/dashboard/sidebar");
const { OverviewDashboard } = await import(
  "@/components/dashboard/overview/overview-dashboard"
);
const { default: TelegramPage } = await import(
  "@/app/(dashboard)/telegram/page"
);
const { default: CustomersPage } = await import(
  "@/app/(dashboard)/customers/page"
);
const { PaymentMethodsManager } = await import(
  "@/components/dashboard/payment-methods/payment-methods-manager"
);

const staleCopy =
  /coming soon|planned for a later phase|planned for upcoming phases|will appear here|Telegram integration is planned/i;

describe("dashboard copy cleanup", () => {
  it("removes stale discovery and coming-soon copy from the sidebar", () => {
    const html = renderToStaticMarkup(createElement(Sidebar));

    expect(html).toContain("Home");
    expect(html).toContain("Store Management");
    expect(html).toContain("Store Setup");
    expect(html).toContain("Advanced Tools");
    expect(html).toContain("Rabet merchant dashboard");
    expect(html).not.toMatch(staleCopy);
    expect(html).not.toContain("Discovery");
  });

  it("describes Telegram accurately without exposing or inventing credentials", () => {
    const html = renderToStaticMarkup(createElement(TelegramPage));

    expect(html).toContain("Telegram / Diagnostics");
    expect(html).toContain("Managed by the operator");
    expect(html).toContain("does not display, edit, or verify");
    expect(html).toContain('href="/settings"');
    expect(html).toContain('href="/storefront"');
    expect(html).toContain('href="/bot-content"');
    expect(html).not.toMatch(staleCopy);
    expect(html).not.toMatch(/webhook secret\s*[:=]/i);
    expect(html).not.toMatch(/t\.me\//i);
  });

  it("keeps Customers honest and points existing workflows to Inquiries", () => {
    const html = renderToStaticMarkup(createElement(CustomersPage));

    expect(html).toContain("Customer profiles are not available yet");
    expect(html).toContain("available now in Inquiries");
    expect(html).toContain('href="/inquiries"');
    expect(html).not.toMatch(staleCopy);
  });

  it("labels payment methods as prototype instructions, not live processing", () => {
    const html = renderToStaticMarkup(
      createElement(PaymentMethodsManager, {
        initialMethods: [],
        defaultLanguage: null,
        languages: [],
        prototypeEnabled: false,
      }),
    );

    expect(html).toContain("Preview Only — No Live Checkout");
    expect(html).toContain("disabled in this deployment");
    expect(html).toMatch(/no live checkout/i);
    expect(html).not.toContain("processes payments");
  });

  it("does not restore outdated overview placeholders", () => {
    const html = renderToStaticMarkup(
      createElement(OverviewDashboard, {
        data: {
          kind: "ready",
          storeName: "Store",
          counts: {
            products: 1,
            categories: 1,
            activeInquiries: 0,
            paymentMethods: 0,
            paymentMethodsAvailable: true,
          },
        },
      }),
    );

    expect(html).not.toMatch(staleCopy);
    expect(html).not.toContain("No activity yet");
  });
});
