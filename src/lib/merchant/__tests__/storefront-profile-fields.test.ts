import { describe, expect, it } from "vitest";

import {
  EMPTY_STOREFRONT_PROFILE,
  parseStorefrontProfile,
  storefrontWelcomeLines,
} from "../storefront-profile-fields";

function inputs(overrides: Partial<typeof EMPTY_STOREFRONT_PROFILE> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...EMPTY_STOREFRONT_PROFILE, ...overrides })) {
    form.set(key, value);
  }
  return form;
}

describe("storefront profile", () => {
  it("keeps merchant-authored text and validates links before saving", () => {
    expect(parseStorefrontProfile(inputs({
      displayName: " متجر نور ",
      welcome: "أهلًا بك",
      coverUrl: "https://cdn.example.test/cover.jpg",
    }))).toEqual({
      ok: true,
      profile: {
        ...EMPTY_STOREFRONT_PROFILE,
        displayName: "متجر نور",
        welcome: "أهلًا بك",
        coverUrl: "https://cdn.example.test/cover.jpg",
      },
    });
  });

  it.each(["javascript:alert(1)", "http://cdn.example.test/cover.jpg", "https://user:pw@cdn.example.test/cover.jpg"])(
    "rejects unsupported image inputs", (coverUrl) => {
      expect(parseStorefrontProfile(inputs({ coverUrl }))).toEqual({ ok: false, field: "coverUrl" });
    },
  );

  it("bounds the description and preserves the default welcome for empty fields", () => {
    expect(parseStorefrontProfile(inputs({ description: "x".repeat(401) }))).toEqual({
      ok: false, field: "description",
    });
    expect(storefrontWelcomeLines(EMPTY_STOREFRONT_PROFILE, "Pilot Store", (name) => `Welcome to ${name}`))
      .toEqual(["Welcome to Pilot Store"]);
  });
});
