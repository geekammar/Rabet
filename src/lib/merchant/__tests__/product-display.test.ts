import { describe, expect, it } from "vitest";

import { resolveMerchantProductName } from "@/lib/merchant/product-display";

describe("merchant product display name", () => {
  it("keeps the established Arabic then English preference", () => {
    expect(
      resolveMerchantProductName(
        {
          en: { name: "English name" },
          ar: { name: "الاسم العربي" },
        },
        "fallback-slug",
      ),
    ).toBe("الاسم العربي");

    expect(
      resolveMerchantProductName({ en: { name: "English name" } }, "fallback-slug"),
    ).toBe("English name");
  });

  it("uses any saved translation before falling back to the slug", () => {
    expect(
      resolveMerchantProductName(
        {
          fr: { name: "" },
          de: { name: "Deutscher Name" },
        },
        "fallback-slug",
      ),
    ).toBe("Deutscher Name");
  });

  it("falls back to the slug only when no translation has a name", () => {
    expect(resolveMerchantProductName({}, "fallback-slug")).toBe("fallback-slug");
    expect(
      resolveMerchantProductName({ fr: { name: "   " } }, "fallback-slug"),
    ).toBe("fallback-slug");
  });
});
