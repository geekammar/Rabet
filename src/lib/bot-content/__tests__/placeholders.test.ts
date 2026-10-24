import { describe, expect, it } from "vitest";

import {
  APPROVED_TEMPLATE_KEYS,
  getTemplateDefinition,
  interpolateTemplate,
  isApprovedTemplateKey,
  TEMPLATE_REGISTRY,
  validateTemplateBody,
} from "../index";

describe("Bot Content Registry & Definitions", () => {
  it("contains exactly the seven approved canonical keys", () => {
    expect(APPROVED_TEMPLATE_KEYS).toEqual([
      "bot_welcome",
      "support_welcome",
      "support_received",
      "inquiry_received",
      "conversation_resolved",
      "option_unavailable",
      "empty_menu",
    ]);
    expect(TEMPLATE_REGISTRY.length).toBe(7);
  });

  it("assigns templates to the four approved groups", () => {
    const groups = new Set(TEMPLATE_REGISTRY.map((t) => t.group));
    expect(groups).toEqual(new Set(["Welcome", "Support", "Inquiries", "Navigation"]));
  });

  it("allows {{store_name}} across all templates, and {{product_name}} only in inquiry_received", () => {
    for (const def of TEMPLATE_REGISTRY) {
      expect(def.allowedPlaceholders).toContain("store_name");
      if (def.key === "inquiry_received") {
        expect(def.allowedPlaceholders).toContain("product_name");
      } else {
        expect(def.allowedPlaceholders).not.toContain("product_name");
      }
    }
  });

  it("checks approved template keys correctly", () => {
    expect(isApprovedTemplateKey("bot_welcome")).toBe(true);
    expect(isApprovedTemplateKey("inquiry_received")).toBe(true);
    expect(isApprovedTemplateKey("custom_message")).toBe(false);
    expect(isApprovedTemplateKey("")).toBe(false);
  });

  it("retrieves template definition by key", () => {
    const def = getTemplateDefinition("bot_welcome");
    expect(def).toBeDefined();
    expect(def?.title).toBe("Main Welcome");
    expect(def?.suggestedText.en).toContain("{{store_name}}");
    expect(def?.suggestedText.ar).toContain("{{store_name}}");
  });
});

describe("validateTemplateBody", () => {
  it("rejects empty, null, or whitespace-only bodies", () => {
    expect(validateTemplateBody("", "bot_welcome")).toMatchObject({
      valid: false,
      error: expect.stringContaining("required"),
    });

    expect(validateTemplateBody("   \n  \t ", "bot_welcome")).toMatchObject({
      valid: false,
      error: expect.stringContaining("required"),
    });
  });

  it("rejects bodies exceeding 4096 characters", () => {
    const overlong = "a".repeat(4097);
    expect(validateTemplateBody(overlong, "bot_welcome")).toMatchObject({
      valid: false,
      error: expect.stringContaining("4096 characters maximum"),
    });
  });

  it("accepts valid bodies with allowed placeholders", () => {
    const res1 = validateTemplateBody(
      "Welcome to {{store_name}}! How can we help?",
      "bot_welcome"
    );
    expect(res1.valid).toBe(true);
    if (res1.valid) {
      expect(res1.placeholders).toEqual(["store_name"]);
    }

    const res2 = validateTemplateBody(
      "Inquiring about {{product_name}} at {{store_name}}.",
      "inquiry_received"
    );
    expect(res2.valid).toBe(true);
    if (res2.valid) {
      expect(res2.placeholders).toEqual(["product_name", "store_name"]);
    }
  });

  it("accepts valid bodies with no placeholders (placeholders are optional)", () => {
    const res = validateTemplateBody(
      "This is a general welcome message with no tags.",
      "bot_welcome"
    );
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.placeholders).toEqual([]);
    }
  });

  it("rejects {{product_name}} in templates other than inquiry_received", () => {
    const res = validateTemplateBody(
      "Welcome to {{store_name}} regarding {{product_name}}!",
      "bot_welcome"
    );
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toContain("Placeholder \"{{product_name}}\" is not allowed in \"bot_welcome\"");
    }
  });

  it("rejects unknown placeholder identifiers", () => {
    const res = validateTemplateBody(
      "Hello {{customer_name}}, welcome to {{store_name}}!",
      "bot_welcome"
    );
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toContain("Unknown placeholder: \"{{customer_name}}\"");
    }
  });

  it("rejects malformed double-brace syntax: triple braces", () => {
    const res = validateTemplateBody(
      "Welcome to {{{store_name}}}!",
      "bot_welcome"
    );
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toContain("triple braces are not allowed");
    }
  });

  it("rejects malformed double-brace syntax: unclosed braces", () => {
    const res = validateTemplateBody(
      "Welcome to {{store_name! How are you?",
      "bot_welcome"
    );
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toContain("unclosed or stray braces");
    }
  });

  it("rejects malformed double-brace syntax: stray closing braces", () => {
    const res = validateTemplateBody(
      "Welcome to store_name}}! How are you?",
      "bot_welcome"
    );
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toContain("unclosed or stray braces");
    }
  });

  it("rejects malformed double-brace syntax: empty braces {{}}", () => {
    const res = validateTemplateBody(
      "Welcome to {{}}!",
      "bot_welcome"
    );
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toContain("Malformed placeholder identifier");
    }
  });

  it("rejects malformed double-brace syntax: spaces inside braces {{ store_name }}", () => {
    const res = validateTemplateBody(
      "Welcome to {{ store_name }}!",
      "bot_welcome"
    );
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toContain("Malformed placeholder identifier");
    }
  });

  it("rejects templates whose preview length exceeds 4096 characters", () => {
    // Body is 4080 + 14 = 4094 chars (<= 4096 stored body limit)
    // Sample context value is 50 chars, so preview length is 4080 + 50 = 4130 chars (> 4096)
    const base = "x".repeat(4080);
    const body = `${base}{{store_name}}`;
    const res = validateTemplateBody(body, "bot_welcome", {
      store_name: "A".repeat(50),
      product_name: "Bag",
    });
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toContain("Preview output exceeds 4096 characters");
    }
  });
});

describe("interpolateTemplate (Safe Interpolation)", () => {
  it("interpolates known placeholders with provided context values", () => {
    const body = "Welcome to {{store_name}}! Viewing {{product_name}}.";
    const result = interpolateTemplate(body, {
      store_name: "Rabet Store",
      product_name: "Leather Belt",
    });
    expect(result).toBe("Welcome to Rabet Store! Viewing Leather Belt.");
  });

  it("preserves line breaks and whitespace", () => {
    const body = "Line 1: {{store_name}}\n\nLine 2:\n- Item 1\n- Item 2";
    const result = interpolateTemplate(body, { store_name: "Shop" });
    expect(result).toBe("Line 1: Shop\n\nLine 2:\n- Item 1\n- Item 2");
  });

  it("guarantees non-recursive interpretation: context placeholder values are not evaluated", () => {
    // Context contains a placeholder value: store_name = "{{product_name}}"
    const body = "Welcome to {{store_name}}!";
    const result = interpolateTemplate(body, {
      store_name: "{{product_name}}",
      product_name: "Should Not Appear",
    });

    // It must NOT recursively evaluate {{product_name}}
    expect(result).toBe("Welcome to {{product_name}}!");
    expect(result).not.toContain("Should Not Appear");
  });

  it("leaves malicious HTML-like text completely inert as plain text", () => {
    const malicious = "<script>alert('xss')</script> <img src=x onerror=alert(1)> {{store_name}}";
    const result = interpolateTemplate(malicious, {
      store_name: "<b>Acme</b>",
    });

    // Result is purely literal strings
    expect(result).toBe("<script>alert('xss')</script> <img src=x onerror=alert(1)> <b>Acme</b>");
  });
});
