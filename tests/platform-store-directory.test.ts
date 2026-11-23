import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(import.meta.dirname, "../src");

function read(relative: string): string {
  return readFileSync(path.join(sourceRoot, relative), "utf8");
}

describe("platform store directory", () => {
  it("guards the page with the platform session and reads the store loader", () => {
    const page = read("app/platform/stores/page.tsx");

    expect(page).toContain("requirePlatformAdmin");
    expect(page).toContain("listPlatformStores");
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
    expect(component).not.toMatch(/merchant_credential|password_hash|token_digest/);
  });
});
