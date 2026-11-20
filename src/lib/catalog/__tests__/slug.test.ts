import { describe, expect, it } from "vitest";

import { generateCatalogSlug } from "@/lib/catalog/slug";

describe("merchant catalog slug generation", () => {
  it("keeps the readable part of a Latin name and appends a unique suffix", () => {
    expect(generateCatalogSlug("product", "Al Noor Product", "abcd1234")).toBe(
      "product-al-noor-product-abcd1234",
    );
  });

  it("falls back to the prefix for a name with no ASCII slug characters", () => {
    expect(generateCatalogSlug("category", "منتجات العناية", "abcd1234")).toBe(
      "category-abcd1234",
    );
  });

  it("produces distinct global slugs for identical display names", () => {
    const first = generateCatalogSlug("product", "Shared name");
    const second = generateCatalogSlug("product", "Shared name");

    expect(first).not.toBe(second);
    expect(first).toMatch(/^product-shared-name-[a-z0-9]+$/);
    expect(first.length).toBeLessThanOrEqual(100);
  });

  it("truncates long names without ending in a separator", () => {
    const slug = generateCatalogSlug("category", "a".repeat(200), "abcd1234");

    expect(slug.length).toBeLessThanOrEqual(100);
    expect(slug).toMatch(/^category-a+-abcd1234$/);
  });
});
