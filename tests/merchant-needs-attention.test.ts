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
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/app/actions/merchant-settings", () => ({
  saveMerchantStoreLanguageAction: vi.fn(),
  saveMerchantTelegramSupportAction: vi.fn(),
}));

vi.mock("@/components/merchant/merchant-logout-button", () => ({
  MerchantLogoutButton: () => null,
}));

vi.mock("@/components/merchant/merchant-telegram-connection", () => ({
  MerchantTelegramConnection: () => null,
}));

const { MerchantNeedsAttention } = await import(
  "@/components/merchant/merchant-needs-attention"
);
const { MerchantSetup } = await import(
  "@/components/merchant/merchant-setup"
);

const orders = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    reference: "ORD-ABC234",
    total: "37.00",
    currency: "SAR",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    reference: "ORD-ABD345",
    total: "122.50",
    currency: "SAR",
  },
];

function renderAttention(
  locale: "ar" | "en",
  items: typeof orders,
  totalPending = items.length,
) {
  return renderToStaticMarkup(
    createElement(MerchantNeedsAttention, {
      locale,
      orders: items,
      totalPending,
    }),
  );
}

describe("Merchant Needs Attention section", () => {
  it("lists pending COD references and totals with deep links in English", () => {
    const html = renderAttention("en", orders);

    expect(html).toContain('data-testid="merchant-needs-attention"');
    expect(html).toContain('data-pending-count="2"');
    expect(html).toContain("Needs Attention");
    expect(html).toContain("2 awaiting acceptance");
    expect(html).toContain("ORD-ABC234");
    expect(html).toContain("ORD-ABD345");
    expect(html).toContain("37.00 SAR");
    expect(html).toContain("122.50 SAR");
    expect(html).toContain(
      `href="/app/orders?order=${orders[0].id}#merchant-order-${orders[0].id}"`,
    );
    expect(html).toContain(
      `href="/app/orders?order=${orders[1].id}#merchant-order-${orders[1].id}"`,
    );
    expect(html).toContain('href="/app/orders"');
    expect(html).toContain("View all orders");
    expect(html).not.toContain('data-testid="merchant-needs-attention-empty"');
  });

  it("renders Arabic copy in RTL with the same order data", () => {
    const html = renderAttention("ar", orders);

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("يحتاج تدخلك");
    expect(html).toContain("بانتظار القبول: 2");
    expect(html).toContain("ORD-ABC234");
    expect(html).toContain("عرض كل الطلبات");
    expect(html).toContain(
      `href="/app/orders?order=${orders[0].id}#merchant-order-${orders[0].id}"`,
    );
  });

  it("shows the full pending count separately from a bounded preview", () => {
    const html = renderAttention("en", orders, 28);

    expect(html).toContain('data-pending-count="28"');
    expect(html).toContain('data-preview-count="2"');
    expect(html).toContain("28 awaiting acceptance");
    expect(html).toContain('data-testid="merchant-needs-attention-preview-note"');
    expect(html).toContain("Showing the first 2 of 28.");
    expect(html).toContain("ORD-ABC234");
  });

  it("localizes the bounded preview note in Arabic", () => {
    const html = renderAttention("ar", orders, 28);

    expect(html).toContain("بانتظار القبول: 28");
    expect(html).toContain("يتم عرض أول 2 من 28.");
  });

  it("shows an honest empty state while keeping the orders route", () => {
    const html = renderAttention("en", []);

    expect(html).toContain('data-pending-count="0"');
    expect(html).toContain('data-testid="merchant-needs-attention-empty"');
    expect(html).toContain("No orders are waiting for acceptance.");
    expect(html).not.toContain('data-testid="merchant-needs-attention-list"');
    expect(html).toContain('href="/app/orders"');
  });
});

describe("Merchant setup entry point", () => {
  function renderSetup(
    overrides: Partial<Parameters<typeof MerchantSetup>[0]> = {},
  ) {
    return renderToStaticMarkup(
      createElement(MerchantSetup, {
        storeName: "Synthetic Store",
        email: "merchant@example.test",
        status: "active",
        readOnly: false,
        initialLocale: "en",
        telegramConnection: { state: "not_connected" },
        isAndroidTelegramLaunch: false,
        telegramLaunchOrigin: null,
        codOrdersEnabled: true,
        needsAttentionOrders: orders,
        needsAttentionTotal: orders.length,
        storeDefaultLanguageCode: "en",
        telegramSupportUsername: null,
        ...overrides,
      }),
    );
  }

  it("places the section on the merchant entry point and keeps the orders route", () => {
    const html = renderSetup();

    expect(html).toContain('data-testid="merchant-setup-page"');
    expect(html).toContain('data-testid="merchant-needs-attention"');
    expect(html).toContain("ORD-ABC234");
    expect(html).toContain('data-testid="merchant-orders-link"');
    expect(html).toContain('href="/app/orders"');
  });

  it("keeps review available for a suspended read-only merchant", () => {
    const html = renderSetup({ readOnly: true, status: "suspended" });

    expect(html).toContain('data-testid="merchant-suspended-notice"');
    expect(html).toContain('data-testid="merchant-needs-attention"');
    expect(html).toContain("ORD-ABC234");
    expect(html).toContain("View all orders");
    expect(html).not.toContain("merchant-order-action-accept");
  });

  it("shows the empty state when COD is enabled with no pending orders", () => {
    const html = renderSetup({
      needsAttentionOrders: [],
      needsAttentionTotal: 0,
    });

    expect(html).toContain('data-pending-count="0"');
    expect(html).toContain("No orders are waiting for acceptance.");
  });

  it("hides the section only when COD is disabled and nothing is pending", () => {
    const html = renderSetup({
      codOrdersEnabled: false,
      needsAttentionOrders: [],
      needsAttentionTotal: 0,
    });

    expect(html).not.toContain('data-testid="merchant-needs-attention"');
  });

  it("still surfaces pending COD orders after COD is disabled", () => {
    const html = renderSetup({ codOrdersEnabled: false });

    expect(html).toContain('data-testid="merchant-needs-attention"');
    expect(html).toContain("ORD-ABC234");
  });
});
