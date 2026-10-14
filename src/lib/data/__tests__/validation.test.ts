import { describe, expect, it } from "vitest";

import {
  CURRENCIES,
  currencySchema,
  displayNameSchema,
  initializeSettingsSchema,
  languageCodeSchema,
  languageLabelSchema,
  messageBodySchema,
  templateKeySchema,
  textDirectionSchema,
} from "@/lib/data";

/**
 * The Zod schemas the data layer validates with before any query runs.
 *
 * They are the first trust boundary for dashboard and setup input, and they
 * mirror constraints the database also enforces — deliberately duplicated so a
 * caller can validate offline and the two sources stay provably in step.
 */

describe("currencySchema", () => {
  it("accepts every member of the schema's allowlist", () => {
    for (const currency of CURRENCIES) {
      expect(currencySchema.safeParse(currency).success).toBe(true);
    }
  });

  it("rejects a currency outside the allowlist", () => {
    expect(currencySchema.safeParse("EUR").success).toBe(false);
    expect(currencySchema.safeParse("sar").success).toBe(false);
    expect(currencySchema.safeParse("").success).toBe(false);
  });
});

describe("displayNameSchema", () => {
  it("requires a non-empty, reasonably short name", () => {
    expect(displayNameSchema.safeParse("Rabet Store").success).toBe(true);
    expect(displayNameSchema.safeParse("").success).toBe(false);
    expect(displayNameSchema.safeParse("   ").success).toBe(false);
    expect(displayNameSchema.safeParse("x".repeat(61)).success).toBe(false);
    expect(displayNameSchema.safeParse("x".repeat(60)).success).toBe(true);
  });
});

describe("languageCodeSchema", () => {
  it("accepts a two-letter lowercase code", () => {
    expect(languageCodeSchema.safeParse("en").success).toBe(true);
    expect(languageCodeSchema.safeParse("ar").success).toBe(true);
  });

  it("rejects anything that is not exactly two lowercase letters", () => {
    expect(languageCodeSchema.safeParse("EN").success).toBe(false);
    expect(languageCodeSchema.safeParse("eng").success).toBe(false);
    expect(languageCodeSchema.safeParse("e").success).toBe(false);
    expect(languageCodeSchema.safeParse("").success).toBe(false);
    expect(languageCodeSchema.safeParse("e1").success).toBe(false);
    // Surrounding whitespace is trimmed before the two-letter rule is applied,
    // so a code with stray spaces normalizes to its letters rather than failing.
    expect(languageCodeSchema.safeParse(" en").success).toBe(true);
  });
});

describe("textDirectionSchema", () => {
  it("accepts the two directions the CHECK constraint allows", () => {
    expect(textDirectionSchema.safeParse("ltr").success).toBe(true);
    expect(textDirectionSchema.safeParse("rtl").success).toBe(true);
  });

  it("rejects anything else", () => {
    expect(textDirectionSchema.safeParse("ttb").success).toBe(false);
    expect(textDirectionSchema.safeParse("LTR").success).toBe(false);
  });
});

describe("languageLabelSchema", () => {
  it("requires a non-empty label within the length cap", () => {
    expect(languageLabelSchema.safeParse("English").success).toBe(true);
    expect(languageLabelSchema.safeParse("العربية").success).toBe(true);
    expect(languageLabelSchema.safeParse("").success).toBe(false);
    expect(languageLabelSchema.safeParse("x".repeat(41)).success).toBe(false);
  });
});

describe("templateKeySchema", () => {
  it("accepts a stable lowercase snake_case identifier", () => {
    expect(templateKeySchema.safeParse("inquiry_received").success).toBe(true);
    expect(templateKeySchema.safeParse("empty_menu").success).toBe(true);
    expect(templateKeySchema.safeParse("home").success).toBe(true);
  });

  it("rejects keys that cannot be stable identifiers", () => {
    expect(templateKeySchema.safeParse("Inquiry Received").success).toBe(false);
    expect(templateKeySchema.safeParse("inquiry-received").success).toBe(false);
    expect(templateKeySchema.safeParse("1_starts_with_a_digit").success).toBe(false);
    expect(templateKeySchema.safeParse("has.dots").success).toBe(false);
    expect(templateKeySchema.safeParse("").success).toBe(false);
  });

  it("enforces the 64-character length cap", () => {
    expect(templateKeySchema.safeParse("x".repeat(64)).success).toBe(true);
    expect(templateKeySchema.safeParse("x".repeat(65)).success).toBe(false);
  });
});

describe("messageBodySchema", () => {
  it("enforces the 4096-character cap the database also checks", () => {
    expect(messageBodySchema.safeParse("Hello").success).toBe(true);
    expect(messageBodySchema.safeParse("x".repeat(4096)).success).toBe(true);
    expect(messageBodySchema.safeParse("x".repeat(4097)).success).toBe(false);
  });

  it("rejects an empty or whitespace-only body", () => {
    expect(messageBodySchema.safeParse("").success).toBe(false);
    expect(messageBodySchema.safeParse("   ").success).toBe(false);
  });
});

describe("initializeSettingsSchema", () => {
  it("requires the identity values and never invents them", () => {
    const valid = {
      defaultLanguageCode: "en",
      currency: "SAR",
      displayName: "Rabet Store",
    };

    const parsed = initializeSettingsSchema.safeParse(valid);

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      // The non-business defaults the schema does supply.
      expect(parsed.data.askForLanguage).toBe(true);
      expect(parsed.data.supportCategory).toEqual([]);
      // An omitted optional resolves to `undefined`; the write path maps that to
      // the column's NULL.
      expect(parsed.data.supportReplyTime).toBeUndefined();
    }
  });

  it("fails without a display name, a currency or a default language", () => {
    expect(
      initializeSettingsSchema.safeParse({ currency: "SAR", displayName: "Store" }).success,
    ).toBe(false);

    expect(
      initializeSettingsSchema.safeParse({
        defaultLanguageCode: "en",
        displayName: "Store",
      }).success,
    ).toBe(false);

    expect(
      initializeSettingsSchema.safeParse({
        defaultLanguageCode: "en",
        currency: "SAR",
      }).success,
    ).toBe(false);
  });

  it("rejects an unconfigured currency at the schema boundary", () => {
    expect(
      initializeSettingsSchema.safeParse({
        defaultLanguageCode: "en",
        currency: "EUR",
        displayName: "Store",
      }).success,
    ).toBe(false);
  });

  it("accepts explicit non-default values", () => {
    const parsed = initializeSettingsSchema.safeParse({
      defaultLanguageCode: "en",
      currency: "USD",
      displayName: "Rabet Store",
      askForLanguage: false,
      supportCategory: ["Order issue", "Refund"],
      supportReplyTime: "within 24 hours",
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.currency).toBe("USD");
      expect(parsed.data.askForLanguage).toBe(false);
      expect(parsed.data.supportCategory).toEqual(["Order issue", "Refund"]);
      expect(parsed.data.supportReplyTime).toBe("within 24 hours");
    }
  });
});
