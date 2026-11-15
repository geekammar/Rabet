import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({ pathname: "/overview" }));

vi.mock("next/navigation", () => ({
  usePathname: () => routeState.pathname,
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

const { DashboardNav } = await import(
  "@/components/dashboard/dashboard-nav"
);

function renderNav(pathname: string, variant: "sidebar" | "mobile" = "sidebar") {
  routeState.pathname = pathname;

  return renderToStaticMarkup(
    createElement(DashboardNav, { variant, className: "p-4" }),
  );
}

describe("DashboardNav", () => {
  it("renders all approved groups in order", () => {
    const html = renderNav("/overview");
    const labels = [
      "Home",
      "Store Management",
      "Store Setup",
      "Advanced Tools",
    ].map((label) => html.indexOf(label));

    expect(labels.every((index) => index >= 0)).toBe(true);
    expect(labels).toEqual([...labels].sort((a, b) => a - b));
    expect(html).toContain('data-testid="sidebar-nav"');
  });

  it("keeps Advanced Tools collapsed by default on Overview", () => {
    const html = renderNav("/overview");

    expect(html).toContain(
      'aria-expanded="false" aria-controls="nav-group-advanced-tools"',
    );
    expect(html).toContain('<ul id="nav-group-advanced-tools" hidden=""');
    expect(html).toContain('href="/catalog"');
    expect(html).toContain('href="/telegram"');
  });

  it("opens Advanced Tools and exposes the active link on a direct advanced URL", () => {
    const html = renderNav("/catalog");

    expect(html).toContain(
      'aria-expanded="true" aria-controls="nav-group-advanced-tools"',
    );
    expect(html).not.toContain('<ul id="nav-group-advanced-tools" hidden=""');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-testid="nav-link-catalog"');
  });

  it("shows the active nested inquiry route", () => {
    const html = renderNav("/inquiries/REF-123");

    const inquiriesIndex = html.indexOf('data-testid="nav-link-inquiries"');
    expect(inquiriesIndex).toBeGreaterThanOrEqual(0);
    expect(html.slice(Math.max(0, inquiriesIndex - 250), inquiriesIndex)).toContain(
      'aria-current="page"',
    );
  });

  it("uses 44px minimum targets and visible focus styles", () => {
    const html = renderNav("/overview");

    expect(html).toContain("min-h-11");
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("focus-visible:ring-offset-2");
  });

  it("uses a real button with aria-expanded and aria-controls for the group", () => {
    const html = renderNav("/overview");

    expect(html).toContain('type="button"');
    expect(html).toContain('id="nav-group-heading-advanced-tools"');
    expect(html).toContain('aria-controls="nav-group-advanced-tools"');
    expect(html).toContain('data-testid="nav-group-toggle-advanced-tools"');
  });

  it("renders the mobile variant with its own test id", () => {
    const html = renderNav("/overview", "mobile");

    expect(html).toContain('data-testid="mobile-nav"');
  });
});
