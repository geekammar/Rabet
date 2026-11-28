import { describe, expect, it } from "vitest";

import {
  MAX_PRODUCT_IMAGE_URL_LENGTH,
  MAX_PRODUCT_STOCK,
  validateProductImageUrl,
  validateProductStock,
} from "@/lib/merchant/product-create";

describe("merchant product image URL validation", () => {
  it("accepts an empty or absent image reference", () => {
    expect(validateProductImageUrl(undefined)).toEqual({
      success: true,
      data: null,
    });
    expect(validateProductImageUrl(null)).toEqual({
      success: true,
      data: null,
    });
    expect(validateProductImageUrl("   ")).toEqual({
      success: true,
      data: null,
    });
  });

  it("accepts http and https URLs and trims surrounding whitespace", () => {
    expect(validateProductImageUrl(" https://cdn.example.test/p.jpg ")).toEqual({
      success: true,
      data: "https://cdn.example.test/p.jpg",
    });
    expect(validateProductImageUrl("http://cdn.example.test/p.jpg")).toEqual({
      success: true,
      data: "http://cdn.example.test/p.jpg",
    });
  });

  it("rejects unsupported schemes, malformed values and oversized URLs", () => {
    expect(validateProductImageUrl("ftp://cdn.example.test/p.jpg").success).toBe(
      false,
    );
    expect(validateProductImageUrl("javascript:alert(1)").success).toBe(false);
    expect(validateProductImageUrl("not a url").success).toBe(false);
    expect(
      validateProductImageUrl(
        `https://cdn.example.test/${"a".repeat(MAX_PRODUCT_IMAGE_URL_LENGTH)}`,
      ).success,
    ).toBe(false);
    expect(validateProductImageUrl(42).success).toBe(false);
  });
});

describe("merchant product stock validation", () => {
  it("treats an absent or blank stock value as not provided", () => {
    expect(validateProductStock(undefined)).toEqual({
      success: true,
      data: null,
    });
    expect(validateProductStock(null)).toEqual({ success: true, data: null });
    expect(validateProductStock("")).toEqual({ success: true, data: null });
    expect(validateProductStock("   ")).toEqual({ success: true, data: null });
  });

  it("accepts whole non-negative quantities", () => {
    expect(validateProductStock("0")).toEqual({ success: true, data: 0 });
    expect(validateProductStock("12")).toEqual({ success: true, data: 12 });
    expect(validateProductStock(7)).toEqual({ success: true, data: 7 });
  });

  it("rejects negative, fractional, non-numeric and oversized quantities", () => {
    expect(validateProductStock("-1").success).toBe(false);
    expect(validateProductStock("1.5").success).toBe(false);
    expect(validateProductStock("ten").success).toBe(false);
    expect(validateProductStock(1.5).success).toBe(false);
    expect(validateProductStock(String(MAX_PRODUCT_STOCK + 1)).success).toBe(
      false,
    );
  });
});
