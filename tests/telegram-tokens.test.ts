import { describe, expect, it } from "vitest";

import {
  assertValidCallbackData,
  parseToken,
  TELEGRAM_MAX_CALLBACK_DATA_BYTES,
  tokens,
} from "@/lib/telegram/tokens";

describe("telegram tokens", () => {
  it("enforces 1-64 UTF-8 bytes ceiling", () => {
    expect(() => assertValidCallbackData("")).toThrow();
    expect(assertValidCallbackData("home")).toBe("home");

    const exact64 = "a".repeat(64);
    expect(assertValidCallbackData(exact64)).toBe(exact64);

    const over64 = "a".repeat(65);
    expect(() => assertValidCallbackData(over64)).toThrow(/must be between 1 and 64 bytes/);

    // Multibyte characters (Arabic / emoji)
    const arabic = "مرحبا"; // 5 chars, 10 UTF-8 bytes
    expect(Buffer.byteLength(arabic, "utf8")).toBe(10);
    expect(assertValidCallbackData(arabic)).toBe(arabic);

    // 33 two-byte characters = 66 bytes -> must throw
    const overMultibyte = "ع".repeat(33);
    expect(Buffer.byteLength(overMultibyte, "utf8")).toBe(66);
    expect(() => assertValidCallbackData(overMultibyte)).toThrow();
  });

  it("builds valid and compact callback tokens", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";

    expect(tokens.home()).toBe("home");
    expect(tokens.lang("en")).toBe("lang:en");
    expect(tokens.lang("ar")).toBe("lang:ar");
    expect(tokens.category(uuid)).toBe(`c:${uuid}`);
    expect(tokens.category(uuid, 2)).toBe(`c:${uuid}:2`);
    expect(tokens.product(uuid)).toBe(`p:${uuid}`);
    expect(tokens.action(uuid)).toBe(`a:${uuid}`);
    expect(tokens.submenu(uuid)).toBe(`m:${uuid}`);
    expect(tokens.submenu(uuid, 3)).toBe(`m:${uuid}:3`);
    expect(tokens.back(uuid)).toBe(`b:${uuid}`);

    // All must be well below 64 bytes
    for (const token of [
      tokens.home(),
      tokens.lang("en"),
      tokens.category(uuid, 99),
      tokens.product(uuid),
      tokens.action(uuid),
      tokens.submenu(uuid, 99),
      tokens.back(uuid),
    ]) {
      expect(Buffer.byteLength(token, "utf8")).toBeLessThanOrEqual(
        TELEGRAM_MAX_CALLBACK_DATA_BYTES,
      );
    }
  });

  it("parses tokens deterministically", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";

    expect(parseToken("home")).toEqual({ type: "home" });
    expect(parseToken("lang:en")).toEqual({ type: "lang", code: "en" });
    expect(parseToken(`c:${uuid}`)).toEqual({
      type: "category",
      categoryId: uuid,
      page: 1,
    });
    expect(parseToken(`c:${uuid}:4`)).toEqual({
      type: "category",
      categoryId: uuid,
      page: 4,
    });
    expect(parseToken(`p:${uuid}`)).toEqual({
      type: "product",
      productId: uuid,
    });
    expect(parseToken(`a:${uuid}`)).toEqual({
      type: "action",
      actionId: uuid,
    });
    expect(parseToken(`m:${uuid}`)).toEqual({
      type: "submenu",
      actionId: uuid,
      page: 1,
    });
    expect(parseToken(`m:${uuid}:2`)).toEqual({
      type: "submenu",
      actionId: uuid,
      page: 2,
    });
    expect(parseToken(`b:${uuid}`)).toEqual({
      type: "back",
      actionId: uuid,
    });
    expect(parseToken("unknown:token")).toEqual({
      type: "unknown",
      raw: "unknown:token",
    });
    expect(parseToken("")).toEqual({
      type: "unknown",
      raw: "",
    });
  });
});
