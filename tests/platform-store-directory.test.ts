import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parsePlatformStorePageParam } from "@/lib/merchant-invitation/platform-admin";

const sourceRoot = path.resolve(import.meta.dirname, "../src");

function read(relative: string): string {
  return readFileSync(path.join(sourceRoot, relative), "utf8");
}

describe("platform store directory", () => {
  it("guards the page with the platform session and reads the store loader", () => {
    const page = read("app/platform/stores/page.tsx");

    expect(page).toContain("requirePlatformAdmin");
    expect(page).toContain("listPlatformStores");
    expect(page).toContain("parsePlatformStorePageParam");
    expect(page).toContain("searchParams");
    expect(page).toContain("await connection()");
    expect(page).not.toMatch(/merchant_credential|password_hash|token_digest/);
  });

  it("exposes Invitations and Stores in the shared platform navigation", () => {
    const nav = read("components/platform/platform-nav.tsx");
    const invitations = read("components/platform/platform-invitations.tsx");
    const stores = read("components/platform/platform-store-directory.tsx");

    expect(nav).toContain('href: "/platform/invitations"');
    expect(nav).toContain('href: "/platform/stores"');
    expect(nav).toContain('label: "Invitations"');
    expect(nav).toContain('label: "Stores"');
    expect(invitations).toContain('PlatformNav active="invitations"');
    expect(stores).toContain('PlatformNav active="stores"');
  });

  it("labels unassigned accounts and missing invitations explicitly", () => {
    const component = read(
      "components/platform/platform-store-directory.tsx",
    );

    expect(component).toContain("No account yet");
    expect(component).toContain("No invitation");
    expect(component).toContain("Invitation pending");
    expect(component).toContain("Invitation accepted");
    expect(component).toContain("Invitation revoked");
    expect(component).toContain("Invitation expired");
    expect(component).toContain("platform-store-pagination");
    expect(component).toContain("platform-store-previous");
    expect(component).toContain("platform-store-next");
    expect(component).toContain("Page {pagination.page} of {pagination.totalPages}");
    expect(component).toContain("/platform/stores?page=");
    expect(component).not.toMatch(/merchant_credential|password_hash|token_digest/);
  });

  it("validates page query input", () => {
    expect(parsePlatformStorePageParam("1")).toBe(1);
    expect(parsePlatformStorePageParam("2")).toBe(2);
    expect(parsePlatformStorePageParam(["3", "4"])).toBe(3);
    expect(parsePlatformStorePageParam("0")).toBe(1);
    expect(parsePlatformStorePageParam("-2")).toBe(1);
    expect(parsePlatformStorePageParam("abc")).toBe(1);
    expect(parsePlatformStorePageParam("2.5")).toBe(1);
    expect(parsePlatformStorePageParam("999999999999999999999")).toBe(1);
    expect(parsePlatformStorePageParam(undefined)).toBe(1);
  });
});
