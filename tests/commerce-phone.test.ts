import { describe, expect, it } from "vitest";

import {
  normalizeAddress,
  normalizeCustomerName,
  normalizePhone,
} from "@/lib/commerce/orders";

describe("commerce phone normalization", () => {
  it("normalizes Arabic-Indic and Eastern Arabic-Indic digits before validation", () => {
    expect(normalizePhone("+٩٦٦ ٥٥٥ ١٢٣ ٤٥٦")).toBe("+966555123456");
    expect(normalizePhone("+۹۶۶ ۵۵۵ ۱۲۳ ۴۵۶")).toBe("+966555123456");
    expect(normalizePhone("٠٧٧١٢٣٤٥٦٧")).toBe("0771234567");
    expect(normalizePhone("۰۷۷۱۲۳۴۵۶۷")).toBe("0771234567");
    expect(normalizePhone("+971 50 123 4567")).toBe("+971501234567");
    expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("rejects malformed or out-of-range phone numbers after normalization", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("+1234567890123456")).toBeNull();
    expect(normalizePhone("phone")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it("keeps address and name validation bounded", () => {
    expect(normalizeAddress(" 123 Synthetic Street ")).toBe(
      "123 Synthetic Street",
    );
    expect(normalizeAddress("١٢٣ شارع الاختبار الاصطناعي")).toBe(
      "١٢٣ شارع الاختبار الاصطناعي",
    );
    expect(normalizeAddress("no")).toBeNull();
    expect(normalizeCustomerName(" Buyer One ")).toBe("Buyer One");
    expect(normalizeCustomerName("   ")).toBeNull();
  });
});
