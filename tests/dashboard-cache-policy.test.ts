import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

describe("dashboard cache policy", () => {
  it("marks every dashboard route and nested route private and non-cacheable", async () => {
    const rules = await nextConfig.headers?.();
    const sources = (rules ?? []).map((rule) => rule.source);

    for (const path of [
      "/overview",
      "/products",
      "/categories",
      "/storefront",
      "/catalog",
      "/payment-methods",
      "/inquiries",
      "/customers",
      "/bot-content",
      "/telegram",
      "/settings",
    ]) {
      expect(sources).toContain(path);
      expect(sources).toContain(`${path}/:path*`);
    }

    for (const rule of rules ?? []) {
      const cacheControl = rule.headers.find(
        (header) => header.key === "Cache-Control",
      );
      expect(cacheControl?.value).toBe("private, no-store, must-revalidate");
    }
  });
});
