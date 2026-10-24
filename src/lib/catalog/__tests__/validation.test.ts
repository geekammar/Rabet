import { describe, expect, it } from "vitest";
import {
  MAX_PRICE_INTEGER_DIGITS,
  validateBoolean,
  validateDescription,
  validateDetails,
  validateName,
  validatePrice,
  validateSlug,
  validateUuid,
} from "../validation";

describe("validatePrice", () => {
  it("accepts valid zero and positive decimal prices without floating point inaccuracy", () => {
    expect(validatePrice("0")).toEqual({ success: true, data: "0.00" });
    expect(validatePrice("0.0")).toEqual({ success: true, data: "0.00" });
    expect(validatePrice("0.00")).toEqual({ success: true, data: "0.00" });
    expect(validatePrice("12")).toEqual({ success: true, data: "12.00" });
    expect(validatePrice("12.5")).toEqual({ success: true, data: "12.50" });
    expect(validatePrice("12.99")).toEqual({ success: true, data: "12.99" });
    expect(validatePrice("1000000.50")).toEqual({ success: true, data: "1000000.50" });
  });

  it("rejects numeric JavaScript numbers to prevent precision loss", () => {
    const res = validatePrice(49);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/must be a string/i);
    }
    expect(validatePrice(12.99).success).toBe(false);
  });

  it("handles leading zeros correctly", () => {
    expect(validatePrice("007.50")).toEqual({ success: true, data: "7.50" });
    expect(validatePrice("000")).toEqual({ success: true, data: "0.00" });
  });

  it("accepts maximum precision of 16 integer digits + 2 decimals", () => {
    const maxInt = "9".repeat(MAX_PRICE_INTEGER_DIGITS);
    expect(validatePrice(`${maxInt}.99`)).toEqual({
      success: true,
      data: `${maxInt}.99`,
    });
  });

  it("rejects negative prices", () => {
    const res = validatePrice("-1.00");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/cannot be negative/i);
    }
  });

  it("rejects scientific / exponent notation", () => {
    const res = validatePrice("1e5");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/scientific or exponent/i);
    }
  });

  it("rejects excessive decimal places (> 2)", () => {
    const res = validatePrice("10.999");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/more than 2 decimal places/i);
    }
  });

  it("rejects integer part exceeding 16 digits", () => {
    const tooLarge = "9".repeat(17);
    const res = validatePrice(`${tooLarge}.00`);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/cannot exceed 16 digits/i);
    }
  });

  it("rejects non-numeric strings and empty input", () => {
    expect(validatePrice("").success).toBe(false);
    expect(validatePrice("   ").success).toBe(false);
    expect(validatePrice("abc").success).toBe(false);
    expect(validatePrice("12.3.4").success).toBe(false);
    expect(validatePrice(null).success).toBe(false);
  });
});

describe("validateSlug", () => {
  it("accepts valid alphanumeric slugs with hyphens, underscores, and periods", () => {
    expect(validateSlug("clothing")).toEqual({ success: true, data: "clothing" });
    expect(validateSlug("t-shirts")).toEqual({ success: true, data: "t-shirts" });
    expect(validateSlug("design.websites.landing")).toEqual({
      success: true,
      data: "design.websites.landing",
    });
    expect(validateSlug("summer_sale_2026")).toEqual({
      success: true,
      data: "summer_sale_2026",
    });
    // Trims and lowercases
    expect(validateSlug("  Tech-Gadgets  ")).toEqual({
      success: true,
      data: "tech-gadgets",
    });
  });

  it("rejects empty or whitespace-only slugs", () => {
    expect(validateSlug("").success).toBe(false);
    expect(validateSlug("   ").success).toBe(false);
  });

  it("rejects slugs with invalid characters or punctuation at edges", () => {
    expect(validateSlug(".test").success).toBe(false);
    expect(validateSlug("test.").success).toBe(false);
    expect(validateSlug("-test").success).toBe(false);
    expect(validateSlug("test-").success).toBe(false);
    expect(validateSlug("test@123").success).toBe(false);
    expect(validateSlug("test space").success).toBe(false);
  });

  it("rejects slugs exceeding 100 characters", () => {
    const longSlug = "a".repeat(101);
    expect(validateSlug(longSlug).success).toBe(false);
  });
});

describe("validateName", () => {
  it("accepts valid trimmed names", () => {
    expect(validateName("  Electronics  ", "English")).toEqual({
      success: true,
      data: "Electronics",
    });
  });

  it("rejects empty names", () => {
    expect(validateName("", "English").success).toBe(false);
    expect(validateName("   ", "English").success).toBe(false);
  });

  it("rejects names over 255 chars", () => {
    const longName = "a".repeat(256);
    expect(validateName(longName, "English").success).toBe(false);
  });
});

describe("validateDescription & validateDetails", () => {
  it("accepts undefined or empty as null", () => {
    expect(validateDescription(undefined).data).toBeNull();
    expect(validateDescription("").data).toBeNull();
    expect(validateDetails(null).data).toBeNull();
    expect(validateDetails("   ").data).toBeNull();
  });

  it("accepts valid trimmed text", () => {
    expect(validateDescription("  Great product!  ").data).toBe("Great product!");
    expect(validateDetails("Full specs and details").data).toBe("Full specs and details");
  });

  it("rejects text exceeding 4096 characters", () => {
    const longText = "a".repeat(4097);
    expect(validateDescription(longText).success).toBe(false);
    expect(validateDetails(longText).success).toBe(false);
  });
});

describe("validateUuid", () => {
  it("accepts valid v4 UUIDs", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(validateUuid(id).success).toBe(true);
  });

  it("rejects invalid UUIDs", () => {
    expect(validateUuid("not-a-uuid").success).toBe(false);
    expect(validateUuid("").success).toBe(false);
  });
});

describe("validateBoolean", () => {
  it("strictly validates boolean and string values accurately", () => {
    expect(validateBoolean(true)).toEqual({ success: true, data: true });
    expect(validateBoolean(false)).toEqual({ success: true, data: false });
    expect(validateBoolean("true")).toEqual({ success: true, data: true });
    expect(validateBoolean("on")).toEqual({ success: true, data: true });
    expect(validateBoolean("1")).toEqual({ success: true, data: true });
    expect(validateBoolean("false")).toEqual({ success: true, data: false });
    expect(validateBoolean("off")).toEqual({ success: true, data: false });
    expect(validateBoolean("0")).toEqual({ success: true, data: false });
  });

  it("rejects undefined, numbers, and malformed strings", () => {
    expect(validateBoolean(undefined).success).toBe(false);
    expect(validateBoolean(null).success).toBe(false);
    expect(validateBoolean(1).success).toBe(false);
    expect(validateBoolean(0).success).toBe(false);
    expect(validateBoolean("yes").success).toBe(false);
    expect(validateBoolean("invalid").success).toBe(false);
  });
});
