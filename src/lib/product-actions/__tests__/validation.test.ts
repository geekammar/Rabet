import { describe, expect, it } from "vitest";

import {
  MAX_ACTION_LABEL_LENGTH,
  MAX_ACTION_MENU_TEXT_LENGTH,
} from "../constants";
import {
  countCharacters,
  validateActionLabel,
  validateActionMenuText,
  validateActionParameters,
  validateActionType,
} from "../validation";

describe("validateActionType", () => {
  it("accepts the three supported action types in Phase 05-B1", () => {
    expect(validateActionType("OPEN_SUBMENU")).toEqual({
      success: true,
      data: "OPEN_SUBMENU",
    });
    expect(validateActionType("SHOW_DETAILS")).toEqual({
      success: true,
      data: "SHOW_DETAILS",
    });
    expect(validateActionType("START_INQUIRY")).toEqual({
      success: true,
      data: "START_INQUIRY",
    });
  });

  it("rejects deferred action types with informative message", () => {
    for (const deferred of [
      "SEND_TEMPLATE_MESSAGE",
      "OPEN_URL",
      "OPEN_SUPPORT",
      "NAVIGATE_CATALOG",
    ]) {
      const res = validateActionType(deferred);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error).toMatch(/deferred and not supported/i);
      }
    }
  });

  it("rejects unknown or invalid action types", () => {
    const res = validateActionType("CUSTOM_EXECUTE");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/invalid action type/i);
    }
  });

  it("rejects non-string values", () => {
    expect(validateActionType(123).success).toBe(false);
    expect(validateActionType(null).success).toBe(false);
    expect(validateActionType(undefined).success).toBe(false);
  });
});

describe("validateActionLabel", () => {
  it("accepts valid labels up to 64 characters", () => {
    expect(validateActionLabel("Choose Options")).toEqual({
      success: true,
      data: "Choose Options",
    });
    const maxLabel = "A".repeat(MAX_ACTION_LABEL_LENGTH);
    expect(validateActionLabel(maxLabel)).toEqual({
      success: true,
      data: maxLabel,
    });
  });

  it("handles multi-byte and emoji characters using Unicode code points", () => {
    // 64 emojis: each emoji is 1 Unicode code point, even though in UTF-16 .length is 2
    const emojis64 = "🚀".repeat(64);
    expect(countCharacters(emojis64)).toBe(64);
    expect(validateActionLabel(emojis64)).toEqual({
      success: true,
      data: emojis64,
    });

    const emojis65 = "🚀".repeat(65);
    const res = validateActionLabel(emojis65);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/64 characters or fewer/i);
    }
  });

  it("rejects empty or whitespace-only labels", () => {
    expect(validateActionLabel("").success).toBe(false);
    expect(validateActionLabel("   ").success).toBe(false);
  });

  it("rejects labels exceeding 64 characters", () => {
    const tooLong = "A".repeat(65);
    const res = validateActionLabel(tooLong);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/64 characters or fewer/i);
    }
  });
});

describe("validateActionMenuText", () => {
  it("accepts optional null, undefined, or empty strings as null", () => {
    expect(validateActionMenuText(null)).toEqual({ success: true, data: null });
    expect(validateActionMenuText(undefined)).toEqual({
      success: true,
      data: null,
    });
    expect(validateActionMenuText("")).toEqual({ success: true, data: null });
    expect(validateActionMenuText("   ")).toEqual({
      success: true,
      data: null,
    });
  });

  it("accepts valid message text up to 4096 characters", () => {
    expect(validateActionMenuText("Please select an option:")).toEqual({
      success: true,
      data: "Please select an option:",
    });

    const maxText = "A".repeat(MAX_ACTION_MENU_TEXT_LENGTH);
    expect(validateActionMenuText(maxText)).toEqual({
      success: true,
      data: maxText,
    });
  });

  it("rejects text exceeding 4096 characters", () => {
    const tooLong = "A".repeat(4097);
    const res = validateActionMenuText(tooLong);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/4096 characters or fewer/i);
    }
  });
});

describe("validateActionParameters", () => {
  it("permits menuText on OPEN_SUBMENU", () => {
    const res = validateActionParameters({
      actionType: "OPEN_SUBMENU",
      menuText: "Select your tier",
    });
    expect(res.success).toBe(true);
  });

  it("rejects menuText on terminal actions SHOW_DETAILS and START_INQUIRY", () => {
    const detailsRes = validateActionParameters({
      actionType: "SHOW_DETAILS",
      menuText: "Details text",
    });
    expect(detailsRes.success).toBe(false);
    if (!detailsRes.success) {
      expect(detailsRes.error).toMatch(/only permitted on OPEN_SUBMENU/i);
    }

    const inquiryRes = validateActionParameters({
      actionType: "START_INQUIRY",
      menuText: "Inquiry text",
    });
    expect(inquiryRes.success).toBe(false);
  });

  it("rejects non-null URL or navigation targets in this slice", () => {
    expect(
      validateActionParameters({
        actionType: "OPEN_SUBMENU",
        url: "https://example.com",
      }).success,
    ).toBe(false);

    expect(
      validateActionParameters({
        actionType: "OPEN_SUBMENU",
        navigateCategoryId: "some-uuid",
      }).success,
    ).toBe(false);

    expect(
      validateActionParameters({
        actionType: "OPEN_SUBMENU",
        navigateProductId: "some-uuid",
      }).success,
    ).toBe(false);
  });

  it("rejects non-empty actionConfig objects", () => {
    expect(
      validateActionParameters({
        actionType: "OPEN_SUBMENU",
        actionConfig: { customField: "value" },
      }).success,
    ).toBe(false);

    // Empty object is accepted
    expect(
      validateActionParameters({
        actionType: "OPEN_SUBMENU",
        actionConfig: {},
      }).success,
    ).toBe(true);
  });
});
