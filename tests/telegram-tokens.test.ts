import { describe, expect, it } from "vitest";

import {
  assertValidCallbackData,
  parseToken,
  TELEGRAM_MAX_CALLBACK_DATA_BYTES,
  tokens,
} from "@/lib/telegram/tokens";

describe("telegram tokens", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";

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
    expect(tokens.home()).toBe("home");
    expect(tokens.rootCategory()).toBe("c:root");
    expect(tokens.rootCategory(2)).toBe("c:root:2");
    expect(tokens.storefrontCategories()).toBe("scats");
    expect(tokens.storefrontCategories(2)).toBe("scats:2");
    expect(tokens.storefrontCategory(uuid)).toBe(`sc:${uuid}`);
    expect(tokens.storefrontCategory(uuid, 2)).toBe(`sc:${uuid}:2`);
    expect(tokens.products()).toBe("prods");
    expect(tokens.products(2)).toBe("prods:2");
    expect(tokens.languages()).toBe("langs");
    expect(tokens.support()).toBe("support");
    expect(tokens.myInquiries()).toBe("myinq");
    expect(tokens.myInquiries(2)).toBe("myinq:2");
    expect(tokens.lang("en")).toBe("lang:en");
    expect(tokens.lang("ar")).toBe("lang:ar");
    expect(tokens.category(uuid)).toBe(`c:${uuid}`);
    expect(tokens.category(uuid, 2)).toBe(`c:${uuid}:2`);
    expect(tokens.product(uuid)).toBe(`p:${uuid}`);
    expect(tokens.productInquiry(uuid)).toBe(`pi:${uuid}`);
    expect(tokens.action(uuid)).toBe(`a:${uuid}`);
    expect(tokens.paymentContact(uuid)).toBe(`pm:${uuid}`);
    expect(tokens.submenu(uuid)).toBe(`m:${uuid}`);
    expect(tokens.submenu(uuid, 3)).toBe(`m:${uuid}:3`);
    expect(tokens.back(uuid)).toBe(`b:${uuid}`);
    expect(tokens.inquiries()).toBe("inq");
    expect(tokens.inquiries(2)).toBe("inq:2");
    expect(tokens.cart()).toBe("cart");
    expect(tokens.cartAdd(uuid, 2)).toBe(`ca:${uuid}:2`);
    expect(tokens.cartIncrease(uuid)).toBe(`ci:${uuid}`);
    expect(tokens.cartDecrease(uuid)).toBe(`cd:${uuid}`);
    expect(tokens.cartRemove(uuid)).toBe(`cr:${uuid}`);
    expect(tokens.checkout(uuid)).toBe(`co:${uuid}`);
    expect(tokens.confirmCod(uuid, 7)).toBe(`cc:${uuid}:7`);
    expect(tokens.backToCart(uuid)).toBe(`cb:${uuid}`);

    // All must be well below 64 bytes
    for (const token of [
      tokens.home(),
      tokens.rootCategory(2),
      tokens.storefrontCategories(2),
      tokens.storefrontCategory(uuid, 2),
      tokens.products(2),
      tokens.languages(),
      tokens.support(),
      tokens.myInquiries(2),
      tokens.lang("en"),
      tokens.category(uuid, 99),
      tokens.product(uuid),
      tokens.productInquiry(uuid),
      tokens.action(uuid),
      tokens.paymentContact(uuid),
      tokens.submenu(uuid, 99),
      tokens.back(uuid),
      tokens.inquiries(),
      tokens.inquiries(99),
      tokens.cart(),
      tokens.cartAdd(uuid, 99),
      tokens.cartIncrease(uuid),
      tokens.cartDecrease(uuid),
      tokens.cartRemove(uuid),
      tokens.checkout(uuid),
      tokens.confirmCod(uuid, 99999),
      tokens.backToCart(uuid),
    ]) {
      expect(Buffer.byteLength(token, "utf8")).toBeLessThanOrEqual(
        TELEGRAM_MAX_CALLBACK_DATA_BYTES,
      );
    }
  });

  it("builder validates identifiers and page numbers strictly", () => {
    expect(() => tokens.category("not-a-uuid")).toThrow(/Invalid category UUID/);
    expect(() => tokens.category(uuid, -1)).toThrow(/Invalid page number/);
    expect(() => tokens.category(uuid, 0)).toThrow(/Invalid page number/);
    expect(() => tokens.category(uuid, 1.5)).toThrow(/Invalid page number/);

    expect(() => tokens.product("bad-id")).toThrow(/Invalid product UUID/);
    expect(() => tokens.productInquiry("bad-id")).toThrow(/Invalid product UUID/);
    expect(() => tokens.action("bad-id")).toThrow(/Invalid action UUID/);
    expect(() => tokens.paymentContact("bad-id")).toThrow(/Invalid action UUID/);
    expect(() => tokens.submenu("bad-id")).toThrow(/Invalid action UUID/);
    expect(() => tokens.submenu(uuid, 0)).toThrow(/Invalid page number/);
    expect(() => tokens.back("bad-id")).toThrow(/Invalid action UUID/);

    expect(() => tokens.lang("invalid!code")).toThrow(/Invalid language code/);
    expect(() => tokens.rootCategory(0)).toThrow(/Invalid page number/);
    expect(() => tokens.rootCategory(-2)).toThrow(/Invalid page number/);
    expect(() => tokens.storefrontCategories(0)).toThrow(/Invalid page number/);
    expect(() => tokens.storefrontCategory("not-a-uuid")).toThrow(/Invalid category UUID/);
    expect(() => tokens.storefrontCategory(uuid, 0)).toThrow(/Invalid page number/);
    expect(() => tokens.products(0)).toThrow(/Invalid page number/);
    expect(() => tokens.products(1.5)).toThrow(/Invalid page number/);
    expect(() => tokens.myInquiries(0)).toThrow(/Invalid page number/);
    expect(() => tokens.myInquiries(-1)).toThrow(/Invalid page number/);
    expect(() => tokens.cartAdd("bad-id", 1)).toThrow(/Invalid product UUID/);
    expect(() => tokens.cartAdd(uuid, 0)).toThrow(/Invalid quantity/);
    expect(() => tokens.cartAdd(uuid, 100)).toThrow(/Invalid quantity/);
    expect(() => tokens.checkout("bad-id")).toThrow(/Invalid cart UUID/);
    expect(() => tokens.confirmCod("bad-id", 1)).toThrow(/Invalid cart UUID/);
    expect(() => tokens.confirmCod(uuid, 0)).toThrow(/Invalid quote version/);
    expect(() => tokens.backToCart("bad-id")).toThrow(/Invalid cart UUID/);
  });

  it("parses tokens deterministically", () => {
    expect(parseToken("home")).toEqual({ type: "home" });
    expect(parseToken("c:root")).toEqual({ type: "root", page: 1 });
    expect(parseToken("c:root:3")).toEqual({ type: "root", page: 3 });
    expect(parseToken("scats")).toEqual({ type: "storefrontCategories", page: 1 });
    expect(parseToken("scats:2")).toEqual({ type: "storefrontCategories", page: 2 });
    expect(parseToken(`sc:${uuid}`)).toEqual({
      type: "storefrontCategory",
      categoryId: uuid,
      page: 1,
    });
    expect(parseToken(`sc:${uuid}:3`)).toEqual({
      type: "storefrontCategory",
      categoryId: uuid,
      page: 3,
    });
    expect(parseToken("prods")).toEqual({ type: "products", page: 1 });
    expect(parseToken("prods:3")).toEqual({ type: "products", page: 3 });
    expect(parseToken("langs")).toEqual({ type: "languages" });
    expect(parseToken("support")).toEqual({ type: "support" });
    expect(parseToken("myinq")).toEqual({ type: "myInquiries", page: 1 });
    expect(parseToken("myinq:2")).toEqual({ type: "myInquiries", page: 2 });
    expect(parseToken("inq")).toEqual({ type: "inquiries", page: 1 });
    expect(parseToken("inq:2")).toEqual({ type: "inquiries", page: 2 });
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
    expect(parseToken(`pi:${uuid}`)).toEqual({
      type: "productInquiry",
      productId: uuid,
    });
    expect(parseToken(`a:${uuid}`)).toEqual({
      type: "action",
      actionId: uuid,
    });
    expect(parseToken(`pm:${uuid}`)).toEqual({
      type: "paymentContact",
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
    expect(parseToken("cart")).toEqual({ type: "cart" });
    expect(parseToken(`ca:${uuid}:3`)).toEqual({
      type: "cartAdd",
      productId: uuid,
      quantity: 3,
    });
    expect(parseToken(`ci:${uuid}`)).toEqual({
      type: "cartIncrease",
      productId: uuid,
    });
    expect(parseToken(`cd:${uuid}`)).toEqual({
      type: "cartDecrease",
      productId: uuid,
    });
    expect(parseToken(`cr:${uuid}`)).toEqual({
      type: "cartRemove",
      productId: uuid,
    });
    expect(parseToken(`co:${uuid}`)).toEqual({
      type: "checkout",
      cartId: uuid,
    });
    expect(parseToken(`cc:${uuid}:4`)).toEqual({
      type: "confirmCod",
      cartId: uuid,
      quoteVersion: 4,
    });
    expect(parseToken(`cb:${uuid}`)).toEqual({
      type: "backToCart",
      cartId: uuid,
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

  it("strictly rejects malformed tokens and invalid page syntax", () => {
    // Malformed category tokens
    expect(parseToken("c:not-a-uuid")).toEqual({ type: "unknown", raw: "c:not-a-uuid" });
    expect(parseToken(`c:${uuid}:2junk`)).toEqual({
      type: "unknown",
      raw: `c:${uuid}:2junk`,
    });
    expect(parseToken(`c:${uuid}:-1`)).toEqual({ type: "unknown", raw: `c:${uuid}:-1` });
    expect(parseToken(`c:${uuid}:0`)).toEqual({ type: "unknown", raw: `c:${uuid}:0` });
    expect(parseToken(`c:${uuid}:1.5`)).toEqual({ type: "unknown", raw: `c:${uuid}:1.5` });
    expect(parseToken(`c:${uuid}:`)).toEqual({ type: "unknown", raw: `c:${uuid}:` });

    // Malformed root category tokens
    expect(parseToken("c:root:abc")).toEqual({ type: "unknown", raw: "c:root:abc" });
    expect(parseToken("c:root:-1")).toEqual({ type: "unknown", raw: "c:root:-1" });
    expect(parseToken("scats:abc")).toEqual({ type: "unknown", raw: "scats:abc" });
    expect(parseToken("sc:not-a-uuid")).toEqual({
      type: "unknown",
      raw: "sc:not-a-uuid",
    });
    expect(parseToken(`sc:${uuid}:0`)).toEqual({
      type: "unknown",
      raw: `sc:${uuid}:0`,
    });
    expect(parseToken("prods:abc")).toEqual({ type: "unknown", raw: "prods:abc" });
    expect(parseToken("prods:0")).toEqual({ type: "unknown", raw: "prods:0" });
    expect(parseToken("myinq:abc")).toEqual({ type: "unknown", raw: "myinq:abc" });
    expect(parseToken("myinq:-1")).toEqual({ type: "unknown", raw: "myinq:-1" });

    // Malformed submenu tokens
    expect(parseToken("m:not-a-uuid")).toEqual({ type: "unknown", raw: "m:not-a-uuid" });
    expect(parseToken(`m:${uuid}:0`)).toEqual({ type: "unknown", raw: `m:${uuid}:0` });
    expect(parseToken(`m:${uuid}:10junk`)).toEqual({
      type: "unknown",
      raw: `m:${uuid}:10junk`,
    });

    // Malformed product, action, back, and language tokens
    expect(parseToken("p:invalid-uuid")).toEqual({ type: "unknown", raw: "p:invalid-uuid" });
    expect(parseToken("pi:invalid-uuid")).toEqual({ type: "unknown", raw: "pi:invalid-uuid" });
    expect(parseToken("a:invalid-uuid")).toEqual({ type: "unknown", raw: "a:invalid-uuid" });
    expect(parseToken("pm:invalid-uuid")).toEqual({ type: "unknown", raw: "pm:invalid-uuid" });
    expect(parseToken("b:invalid-uuid")).toEqual({ type: "unknown", raw: "b:invalid-uuid" });
    expect(parseToken("lang:invalid!code")).toEqual({
      type: "unknown",
      raw: "lang:invalid!code",
    });
    expect(parseToken("ca:not-a-uuid:1")).toEqual({
      type: "unknown",
      raw: "ca:not-a-uuid:1",
    });
    expect(parseToken(`ca:${uuid}:0`)).toEqual({
      type: "unknown",
      raw: `ca:${uuid}:0`,
    });
    expect(parseToken(`cc:${uuid}:0`)).toEqual({
      type: "unknown",
      raw: `cc:${uuid}:0`,
    });
    expect(parseToken("co:not-a-uuid")).toEqual({
      type: "unknown",
      raw: "co:not-a-uuid",
    });

    // Overlength payload (>64 bytes)
    const overlength = "c:" + "a".repeat(70);
    expect(parseToken(overlength)).toEqual({ type: "unknown", raw: overlength });
  });
});
