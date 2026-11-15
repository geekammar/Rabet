import { describe, expect, it } from "vitest";

import {
  getNavGroupForPath,
  getNavGroupOpenState,
  isNavItemActive,
  navGroups,
  navItems,
} from "@/lib/navigation";

describe("dashboard navigation groups", () => {
  it("keeps the approved group order and labels", () => {
    expect(navGroups.map((group) => group.label)).toEqual([
      "Home",
      "Store Management",
      "Store Setup",
      "Advanced Tools",
    ]);
  });

  it("keeps the approved item order inside every group", () => {
    expect(navGroups[0].items.map((item) => item.label)).toEqual(["Overview"]);
    expect(navGroups[1].items.map((item) => item.label)).toEqual([
      "Products",
      "Categories",
      "Inquiries",
      "Payment Methods",
      "Customers",
    ]);
    expect(navGroups[2].items.map((item) => item.label)).toEqual([
      "Storefront",
      "Bot Content",
      "Settings",
    ]);
    expect(navGroups[3].items.map((item) => item.label)).toEqual([
      "Advanced Catalog",
      "Telegram / Diagnostics",
    ]);
  });

  it("exports a flat list with unique destinations", () => {
    const hrefs = navItems.map((item) => item.href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs).toEqual([
      "/overview",
      "/products",
      "/categories",
      "/inquiries",
      "/payment-methods",
      "/customers",
      "/storefront",
      "/bot-content",
      "/settings",
      "/catalog",
      "/telegram",
    ]);
  });

  it("marks only Advanced Tools as collapsible and closed by default", () => {
    expect(navGroups[3]).toMatchObject({
      id: "advanced-tools",
      collapsible: true,
      defaultOpen: false,
    });
    expect(navGroups.slice(0, 3).every((group) => !group.collapsible)).toBe(true);
  });

  it("matches active routes including nested direct links", () => {
    expect(isNavItemActive("/overview", "/overview")).toBe(true);
    expect(isNavItemActive("/products", "/products")).toBe(true);
    expect(isNavItemActive("/products/abc", "/products")).toBe(true);
    expect(isNavItemActive("/inquiries/ref-123", "/inquiries")).toBe(true);
    expect(isNavItemActive("/catalog", "/catalog")).toBe(true);
    expect(isNavItemActive("/productivity", "/products")).toBe(false);
  });

  it("opens Advanced Tools only when the current route belongs to it", () => {
    expect(getNavGroupOpenState("/overview")["advanced-tools"]).toBe(false);
    expect(getNavGroupOpenState("/products")["advanced-tools"]).toBe(false);
    expect(getNavGroupOpenState("/catalog")["advanced-tools"]).toBe(true);
    expect(getNavGroupOpenState("/telegram")["advanced-tools"]).toBe(true);
  });

  it("finds the group that owns the active route", () => {
    expect(getNavGroupForPath("/catalog")?.id).toBe("advanced-tools");
    expect(getNavGroupForPath("/inquiries/ref-123")?.id).toBe("store-management");
    expect(getNavGroupForPath("/settings")?.id).toBe("store-setup");
    expect(getNavGroupForPath("/unknown")).toBeUndefined();
  });
});
