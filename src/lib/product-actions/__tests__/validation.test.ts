import { describe, expect, it } from "vitest";

import {
  MAX_ACTION_LABEL_LENGTH,
  MAX_ACTION_MENU_TEXT_LENGTH,
  SUPPORTED_ACTION_TYPES,
} from "../constants";
import {
  interpolateActionTemplate,
  validateActionTemplateBody,
} from "../templates";
import {
  countCharacters,
  validateActionConfig,
  validateActionLabel,
  validateActionMenuText,
  validateActionParameters,
  validateActionType,
  validateHttpsUrl,
} from "../validation";

describe("validateActionType", () => {
  it("accepts all seven approved action types", () => {
    for (const type of SUPPORTED_ACTION_TYPES) {
      expect(validateActionType(type)).toEqual({
        success: true,
        data: type,
      });
    }
  });

  it("rejects unknown or arbitrary action types", () => {
    for (const invalid of ["CUSTOM_EXECUTE", "DOWNLOAD_FILE", "RUN_SCRIPT", ""]) {
      const res = validateActionType(invalid);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error).toMatch(/invalid action type/i);
      }
    }
  });

  it("rejects non-string values", () => {
    expect(validateActionType(123).success).toBe(false);
    expect(validateActionType(null).success).toBe(false);
    expect(validateActionType(undefined).success).toBe(false);
    expect(validateActionType({}).success).toBe(false);
  });
});

describe("countCharacters and validateActionLabel", () => {
  it("counts Unicode code points correctly", () => {
    expect(countCharacters("hello")).toBe(5);
    expect(countCharacters("مرحبا")).toBe(5);
    expect(countCharacters("🚀✨")).toBe(2);
  });

  it("accepts valid labels in English and Arabic", () => {
    expect(validateActionLabel("Choose Options", "English").success).toBe(true);
    expect(validateActionLabel("خيارات الشراء", "Arabic").success).toBe(true);
  });

  it("rejects empty or whitespace labels", () => {
    expect(validateActionLabel("", "English").success).toBe(false);
    expect(validateActionLabel("   ", "English").success).toBe(false);
    expect(validateActionLabel(null, "English").success).toBe(false);
  });

  it("rejects labels exceeding MAX_ACTION_LABEL_LENGTH code points", () => {
    const long = "A".repeat(MAX_ACTION_LABEL_LENGTH + 1);
    const res = validateActionLabel(long, "English");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/64 characters or fewer/i);
    }
  });
});

describe("validateActionMenuText", () => {
  it("accepts null or undefined for optional menu text", () => {
    expect(validateActionMenuText(null).success).toBe(true);
    expect(validateActionMenuText(undefined).success).toBe(true);
    expect(validateActionMenuText("").data).toBe(null);
  });

  it("accepts valid menu text", () => {
    const res = validateActionMenuText("Please select your preferred tier below:");
    expect(res.success).toBe(true);
    expect(res.data).toBe("Please select your preferred tier below:");
  });

  it("rejects menu text exceeding MAX_ACTION_MENU_TEXT_LENGTH", () => {
    const long = "M".repeat(MAX_ACTION_MENU_TEXT_LENGTH + 1);
    const res = validateActionMenuText(long);
    expect(res.success).toBe(false);
  });
});

describe("validateHttpsUrl", () => {
  it("accepts valid absolute HTTPS URLs", () => {
    const validUrls = [
      "https://example.com",
      "https://sub.domain.co.uk/path/to/resource?query=1#hash",
      "https://api.github.com/geekammar/Rabet",
    ];

    for (const url of validUrls) {
      const res = validateHttpsUrl(url);
      expect(res.success).toBe(true);
      expect(res.data).toBe(url);
    }
  });

  it("rejects non-HTTPS protocols (http, javascript, data, file)", () => {
    const invalidProtocols = [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,<html></html>",
      "file:///etc/passwd",
      "ftp://example.com/file",
    ];

    for (const url of invalidProtocols) {
      const res = validateHttpsUrl(url);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error).toMatch(/HTTPS/i);
      }
    }
  });

  it("rejects URLs with embedded credentials", () => {
    const res = validateHttpsUrl("https://user:pass@example.com/login");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/embedded credentials/i);
    }
  });

  it("rejects URLs with whitespace or control characters", () => {
    expect(validateHttpsUrl("https://example.com/path with spaces").success).toBe(false);
    expect(validateHttpsUrl("https://example.com/\x00bad").success).toBe(false);
  });

  it("rejects malformed URLs or non-strings", () => {
    expect(validateHttpsUrl("not-a-url").success).toBe(false);
    expect(validateHttpsUrl("").success).toBe(false);
    expect(validateHttpsUrl(null).success).toBe(false);
    expect(validateHttpsUrl(12345).success).toBe(false);
  });
});

describe("validateActionTemplateBody and interpolateActionTemplate", () => {
  it("accepts valid template bodies with allowed placeholders", () => {
    const body =
      "Hello {{customer_name}}! Thanks for checking {{product_name}} at {{store_name}}. Price: {{price}}.";
    const res = validateActionTemplateBody(body, { required: true });
    expect(res.success).toBe(true);
    expect(res.placeholders).toEqual([
      "customer_name",
      "product_name",
      "store_name",
      "price",
    ]);
  });

  it("interpolates context non-recursively in a single pass", () => {
    const body = "Welcome to {{store_name}}!";
    // Context itself containing {{placeholder}} syntax
    const context = {
      store_name: "Store {{product_name}}",
      product_name: "Ignored Nested",
      customer_name: "Sarah",
      price: "USD 10",
    };
    const interpolated = interpolateActionTemplate(body, context);
    // Should NOT expand nested {{product_name}}
    expect(interpolated).toBe("Welcome to Store {{product_name}}!");
  });

  it("rejects triple braces", () => {
    const res = validateActionTemplateBody("Hello {{{customer_name}}}!");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/triple braces/i);
    }
  });

  it("rejects unclosed or stray braces", () => {
    expect(validateActionTemplateBody("Hello {{customer_name!").success).toBe(false);
    expect(validateActionTemplateBody("Hello customer_name}}!").success).toBe(false);
    expect(validateActionTemplateBody("Hello {{ customer_name }}!").success).toBe(false);
  });

  it("rejects unknown placeholders", () => {
    const res = validateActionTemplateBody("Hello {{customer_email}}!");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/unknown placeholder/i);
    }
  });

  it("preserves line breaks verbatim", () => {
    const body = "Line 1\nLine 2\n\nLine 4";
    const res = validateActionTemplateBody(body);
    expect(res.success).toBe(true);
    expect(res.data).toBe(body);
  });

  it("rejects template bodies exceeding 4096 characters", () => {
    const long = "A".repeat(4097);
    const res = validateActionTemplateBody(long);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/4096/i);
    }
  });

  it("requires body when required: true", () => {
    expect(validateActionTemplateBody("", { required: true }).success).toBe(false);
    expect(validateActionTemplateBody(null, { required: true }).success).toBe(false);
    expect(validateActionTemplateBody(undefined, { required: true }).success).toBe(false);
  });
});

describe("validateActionConfig", () => {
  it("accepts empty object or omission for non-support actions", () => {
    expect(validateActionConfig({}, "OPEN_SUBMENU")).toEqual({
      success: true,
      data: {},
    });
    expect(validateActionConfig(null, "OPEN_SUBMENU")).toEqual({
      success: true,
      data: {},
    });
    expect(validateActionConfig(undefined, "OPEN_SUBMENU")).toEqual({
      success: true,
      data: {},
    });
  });

  it("rejects custom keys for non-support actions", () => {
    const res = validateActionConfig({ customKey: "val" }, "OPEN_SUBMENU");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/Custom actionConfig properties are not supported/i);
    }
  });

  it("accepts valid support_category for OPEN_SUPPORT", () => {
    const res = validateActionConfig(
      { support_category: "Refunds" },
      "OPEN_SUPPORT",
      false,
      ["Refunds", "General"],
    );
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ support_category: "Refunds" });
  });

  it("rejects unconfigured support_category for OPEN_SUPPORT when allowlist is provided", () => {
    const res = validateActionConfig(
      { support_category: "UnconfiguredCategory" },
      "OPEN_SUPPORT",
      false,
      ["Refunds", "General"],
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/not configured in store settings/i);
    }
  });

  it("rejects extra keys on OPEN_SUPPORT", () => {
    const res = validateActionConfig(
      { support_category: "Refunds", extraKey: "forbidden" },
      "OPEN_SUPPORT",
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/only accepts optional "support_category"/i);
    }
  });

  it("parses and validates FormData representations", () => {
    expect(validateActionConfig("", true)).toEqual({
      success: true,
      data: {},
    });
    expect(validateActionConfig("{}", true)).toEqual({
      success: true,
      data: {},
    });
    expect(validateActionConfig('{"foo": "bar"}', true).success).toBe(false);
    expect(validateActionConfig("not json", true).success).toBe(false);
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

  it("rejects menuText on terminal actions", () => {
    for (const term of [
      "SHOW_DETAILS",
      "START_INQUIRY",
      "SEND_TEMPLATE_MESSAGE",
      "OPEN_URL",
      "OPEN_SUPPORT",
      "NAVIGATE_CATALOG",
    ] as const) {
      const res = validateActionParameters({
        actionType: term,
        menuText: "Details text",
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error).toMatch(/only permitted on OPEN_SUBMENU/i);
      }
    }
  });

  it("rejects templateBody on non-SEND_TEMPLATE_MESSAGE actions", () => {
    const res = validateActionParameters({
      actionType: "OPEN_URL",
      templateBody: "Sample body",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/only permitted on SEND_TEMPLATE_MESSAGE/i);
    }
  });

  it("rejects url on non-OPEN_URL actions", () => {
    const res = validateActionParameters({
      actionType: "SHOW_DETAILS",
      url: "https://example.com",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/only permitted on OPEN_URL/i);
    }
  });

  it("rejects navigation targets on non-NAVIGATE_CATALOG actions", () => {
    const res = validateActionParameters({
      actionType: "OPEN_SUBMENU",
      navigateCategoryId: "some-uuid",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/only permitted on NAVIGATE_CATALOG/i);
    }
  });

  it("rejects both navigation targets specified together", () => {
    const res = validateActionParameters({
      actionType: "NAVIGATE_CATALOG",
      navigateCategoryId: "cat-uuid",
      navigateProductId: "prod-uuid",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toMatch(/cannot specify both/i);
    }
  });
});
