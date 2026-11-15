import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  connection: vi.fn().mockResolvedValue(undefined),
}));

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

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockLoadOverviewData = vi.fn();
vi.mock("@/lib/dashboard/overview", () => ({
  loadOverviewData: () => mockLoadOverviewData(),
}));

const OverviewPage = (await import("@/app/(dashboard)/overview/page")).default;
const { OverviewDashboard } = await import(
  "@/components/dashboard/overview/overview-dashboard"
);

const readyData = {
  kind: "ready" as const,
  storeName: "Rabet Demo Store",
  counts: {
    products: 7,
    categories: 3,
    activeInquiries: 2,
    paymentMethods: 4,
    paymentMethodsAvailable: true,
  },
};

function renderOverview(data: Parameters<typeof OverviewDashboard>[0]["data"]) {
  return renderToStaticMarkup(createElement(OverviewDashboard, { data }));
}

describe("Overview page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      email: "admin@rabet.test",
      role: "admin",
    });
  });

  it("checks the admin boundary before loading counts", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("Unauthorized"));
    mockLoadOverviewData.mockResolvedValueOnce(readyData);

    await expect(OverviewPage()).rejects.toThrow("Unauthorized");
    expect(mockLoadOverviewData).not.toHaveBeenCalled();
  });

  it("renders the dashboard with the loaded server data", async () => {
    mockLoadOverviewData.mockResolvedValueOnce(readyData);

    const element = await OverviewPage();

    expect(element.type.name).toBe("OverviewDashboard");
    expect(element.props.data).toEqual(readyData);
  });
});

describe("Overview dashboard content", () => {
  it("renders real counts, store name and task-oriented quick actions", () => {
    const html = renderOverview(readyData);

    expect(html).toContain('data-testid="overview-dashboard"');
    expect(html).toContain("Rabet Demo Store");
    expect(html).toContain('data-count="7"');
    expect(html).toContain('data-count="3"');
    expect(html).toContain('data-count="2"');
    expect(html).toContain('data-count="4"');
    expect(html).toContain("2 conversations are open or waiting on a customer.");
    expect(html).toContain("Prototype instructions only. No live payment processing.");

    for (const href of [
      "/products",
      "/categories",
      "/inquiries",
      "/storefront",
      "/payment-methods",
      "/telegram",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }

    expect(html).toContain('data-testid="overview-quick-action-add-product"');
    expect(html).toContain('data-testid="overview-quick-action-add-category"');
    expect(html).toContain('data-testid="overview-quick-action-view-inquiries"');
    expect(html).toContain(
      'data-testid="overview-quick-action-configure-storefront"',
    );
    expect(html).toContain(
      'data-testid="overview-quick-action-manage-payment-methods"',
    );
    expect(html).toContain('data-testid="overview-quick-action-telegram-diagnostics"');
  });

  it("handles an empty store without inventing activity", () => {
    const html = renderOverview({
      kind: "ready",
      storeName: "Empty Store",
      counts: {
        products: 0,
        categories: 0,
        activeInquiries: 0,
        paymentMethods: 0,
        paymentMethodsAvailable: true,
      },
    });

    expect(html).toContain("No customer conversations are open or waiting.");
    expect(html).toContain('data-count="0"');
    expect(html).not.toMatch(/revenue|sales|orders|conversion/i);
  });

  it("explains database setup required without fake counts", () => {
    const html = renderOverview({ kind: "database_setup_required" });

    expect(html).toContain('data-testid="overview-notice-warning"');
    expect(html).toContain("Database setup required");
    expect(html).not.toContain("overview-stats");
    expect(html).toContain('href="/settings"');
  });

  it("shows the safe database-unavailable message and keeps quick actions", () => {
    const html = renderOverview({
      kind: "database_unavailable",
      message: "The database is not reachable right now. Try again in a moment.",
    });

    expect(html).toContain('data-testid="overview-notice-danger"');
    expect(html).toContain(
      "The database is not reachable right now. Try again in a moment.",
    );
    expect(html).not.toContain("overview-stats");
    expect(html).toContain('data-testid="overview-quick-action-add-product"');
  });

  it("prompts for store setup when settings are not initialized", () => {
    const html = renderOverview({ kind: "store_setup_required" });

    expect(html).toContain('data-testid="overview-notice-info"');
    expect(html).toContain("Finish setting up your store");
    expect(html).toContain("Complete store setup");
    expect(html).not.toContain("overview-stats");
  });

  it("does not repeat outdated placeholder copy", () => {
    const html = renderOverview(readyData);

    expect(html).not.toMatch(/coming soon/i);
    expect(html).not.toMatch(/planned for/i);
    expect(html).not.toMatch(/will appear here/i);
    expect(html).not.toMatch(/not yet implemented/i);
  });
});
