/**
 * Compact self-scoping callback token contract for Telegram inline keyboards.
 *
 * All callback_data values are validated against Telegram's strict 1-64 byte limit
 * using UTF-8 byte length, not character count.
 */

export const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64;

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LANG_CODE_REGEX = /^[a-z]{2}$/;
export const PAGE_REGEX = /^[1-9][0-9]{0,4}$/;
const LANGUAGE_CONTEXT_PATTERN =
  /^(?:h|p:[1-9][0-9]{0,4}|cs|c:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[1-9][0-9]{0,4})?|pd:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|to:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function assertLanguageContext(context: string | undefined): string | null {
  if (context === undefined) return null;
  if (!LANGUAGE_CONTEXT_PATTERN.test(context)) {
    throw new Error(`Invalid language context: "${context}"`);
  }
  return context;
}

export function assertValidCallbackData(data: string): string {
  const byteLen = Buffer.byteLength(data, "utf8");
  if (byteLen < 1 || byteLen > TELEGRAM_MAX_CALLBACK_DATA_BYTES) {
    throw new Error(
      `Invalid callback_data length: ${byteLen} bytes (must be between 1 and ${TELEGRAM_MAX_CALLBACK_DATA_BYTES} bytes).`,
    );
  }
  return data;
}

export const tokens = {
  home: (): string => assertValidCallbackData("home"),
  homeNew: (): string => assertValidCallbackData("home:new"),
  rootCategory: (page?: number): string => {
    if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 99999)) {
      throw new Error(`Invalid page number: ${page}`);
    }
    return assertValidCallbackData(page && page > 1 ? `c:root:${page}` : "c:root");
  },
  storefrontCategories: (page?: number): string => {
    if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 99999)) {
      throw new Error(`Invalid page number: ${page}`);
    }
    return assertValidCallbackData(page && page > 1 ? `scats:${page}` : "scats");
  },
  storefrontCategory: (categoryId: string, page?: number): string => {
    if (!UUID_REGEX.test(categoryId)) {
      throw new Error(`Invalid category UUID: "${categoryId}"`);
    }
    if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 99999)) {
      throw new Error(`Invalid page number: ${page}`);
    }
    return assertValidCallbackData(
      page && page > 1 ? `sc:${categoryId}:${page}` : `sc:${categoryId}`,
    );
  },
  cart: (): string => assertValidCallbackData("cart"),
  cartAdd: (productId: string, quantity: number): string => {
    if (!UUID_REGEX.test(productId)) {
      throw new Error(`Invalid product UUID: "${productId}"`);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new Error(`Invalid quantity: ${quantity}`);
    }
    return assertValidCallbackData(`ca:${productId}:${quantity}`);
  },
  cartIncrease: (productId: string): string => {
    if (!UUID_REGEX.test(productId)) {
      throw new Error(`Invalid product UUID: "${productId}"`);
    }
    return assertValidCallbackData(`ci:${productId}`);
  },
  cartDecrease: (productId: string): string => {
    if (!UUID_REGEX.test(productId)) {
      throw new Error(`Invalid product UUID: "${productId}"`);
    }
    return assertValidCallbackData(`cd:${productId}`);
  },
  cartRemove: (productId: string): string => {
    if (!UUID_REGEX.test(productId)) {
      throw new Error(`Invalid product UUID: "${productId}"`);
    }
    return assertValidCallbackData(`cr:${productId}`);
  },
  checkout: (cartId: string): string => {
    if (!UUID_REGEX.test(cartId)) {
      throw new Error(`Invalid cart UUID: "${cartId}"`);
    }
    return assertValidCallbackData(`co:${cartId}`);
  },
  confirmCod: (cartId: string, quoteVersion: number): string => {
    if (!UUID_REGEX.test(cartId)) {
      throw new Error(`Invalid cart UUID: "${cartId}"`);
    }
    if (!Number.isInteger(quoteVersion) || quoteVersion < 1 || quoteVersion > 99999) {
      throw new Error(`Invalid quote version: ${quoteVersion}`);
    }
    return assertValidCallbackData(`cc:${cartId}:${quoteVersion}`);
  },
  backToCart: (cartId: string): string => {
    if (!UUID_REGEX.test(cartId)) {
      throw new Error(`Invalid cart UUID: "${cartId}"`);
    }
    return assertValidCallbackData(`cb:${cartId}`);
  },
  confirmVodafoneCash: (cartId: string, quoteVersion: number): string => {
    if (!UUID_REGEX.test(cartId)) {
      throw new Error(`Invalid cart UUID: "${cartId}"`);
    }
    if (!Number.isInteger(quoteVersion) || quoteVersion < 1 || quoteVersion > 99999) {
      throw new Error(`Invalid quote version: ${quoteVersion}`);
    }
    return assertValidCallbackData(`cv:${cartId}:${quoteVersion}`);
  },
  transferReference: (orderId: string): string => {
    if (!UUID_REGEX.test(orderId)) {
      throw new Error(`Invalid order UUID: "${orderId}"`);
    }
    return assertValidCallbackData(`tr:${orderId}`);
  },
  transferList: (): string => assertValidCallbackData("tfl"),
  transferOrder: (orderId: string): string => {
    if (!UUID_REGEX.test(orderId)) {
      throw new Error(`Invalid order UUID: "${orderId}"`);
    }
    return assertValidCallbackData(`tfo:${orderId}`);
  },
  products: (page?: number): string => {
    if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 99999)) {
      throw new Error(`Invalid page number: ${page}`);
    }
    return assertValidCallbackData(page && page > 1 ? `prods:${page}` : "prods");
  },
  languages: (context?: string): string => {
    const parsed = assertLanguageContext(context);
    return assertValidCallbackData(parsed ? `langs:${parsed}` : "langs");
  },
  support: (): string => assertValidCallbackData("support"),
  myInquiries: (page?: number): string => {
    if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 99999)) {
      throw new Error(`Invalid page number: ${page}`);
    }
    return assertValidCallbackData(page && page > 1 ? `myinq:${page}` : "myinq");
  },
  lang: (code: string, context?: string): string => {
    if (!LANG_CODE_REGEX.test(code)) {
      throw new Error(`Invalid language code format: "${code}"`);
    }
    const parsed = assertLanguageContext(context);
    return assertValidCallbackData(
      parsed ? `lang:${code}:${parsed}` : `lang:${code}`,
    );
  },
  category: (categoryId: string, page?: number): string => {
    if (categoryId !== "root" && !UUID_REGEX.test(categoryId)) {
      throw new Error(`Invalid category UUID: "${categoryId}"`);
    }
    if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 99999)) {
      throw new Error(`Invalid page number: ${page}`);
    }
    return assertValidCallbackData(
      page && page > 1 ? `c:${categoryId}:${page}` : `c:${categoryId}`,
    );
  },
  product: (productId: string): string => {
    if (!UUID_REGEX.test(productId)) {
      throw new Error(`Invalid product UUID: "${productId}"`);
    }
    return assertValidCallbackData(`p:${productId}`);
  },
  productInquiry: (productId: string): string => {
    if (!UUID_REGEX.test(productId)) {
      throw new Error(`Invalid product UUID: "${productId}"`);
    }
    return assertValidCallbackData(`pi:${productId}`);
  },
  action: (actionId: string): string => {
    if (!UUID_REGEX.test(actionId)) {
      throw new Error(`Invalid action UUID: "${actionId}"`);
    }
    return assertValidCallbackData(`a:${actionId}`);
  },
  paymentContact: (actionId: string): string => {
    if (!UUID_REGEX.test(actionId)) {
      throw new Error(`Invalid action UUID: "${actionId}"`);
    }
    return assertValidCallbackData(`pm:${actionId}`);
  },
  submenu: (actionId: string, page?: number): string => {
    if (!UUID_REGEX.test(actionId)) {
      throw new Error(`Invalid action UUID: "${actionId}"`);
    }
    if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 99999)) {
      throw new Error(`Invalid page number: ${page}`);
    }
    return assertValidCallbackData(
      page && page > 1 ? `m:${actionId}:${page}` : `m:${actionId}`,
    );
  },
  back: (actionId: string): string => {
    if (!UUID_REGEX.test(actionId)) {
      throw new Error(`Invalid action UUID: "${actionId}"`);
    }
    return assertValidCallbackData(`b:${actionId}`);
  },
  inquiries: (page?: number): string => {
    if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 99999)) {
      throw new Error(`Invalid page number: ${page}`);
    }
    return assertValidCallbackData(page && page > 1 ? `inq:${page}` : "inq");
  },
};

export type ParsedToken =
  | { type: "home" }
  | { type: "homeNew" }
  | { type: "root"; page: number }
  | { type: "storefrontCategories"; page: number }
  | { type: "storefrontCategory"; categoryId: string; page: number }
  | { type: "cart" }
  | { type: "cartAdd"; productId: string; quantity: number }
  | { type: "cartIncrease"; productId: string }
  | { type: "cartDecrease"; productId: string }
  | { type: "cartRemove"; productId: string }
  | { type: "checkout"; cartId: string }
  | { type: "confirmCod"; cartId: string; quoteVersion: number }
  | { type: "confirmVodafoneCash"; cartId: string; quoteVersion: number }
  | { type: "backToCart"; cartId: string }
  | { type: "transferReference"; orderId: string }
  | { type: "transferList" }
  | { type: "transferOrder"; orderId: string }
  | { type: "products"; page: number }
  | { type: "languages"; context: string | null }
  | { type: "support" }
  | { type: "myInquiries"; page: number }
  | { type: "lang"; code: string; context: string | null }
  | { type: "category"; categoryId: string; page: number }
  | { type: "product"; productId: string }
  | { type: "productInquiry"; productId: string }
  | { type: "action"; actionId: string }
  | { type: "paymentContact"; actionId: string }
  | { type: "submenu"; actionId: string; page: number }
  | { type: "back"; actionId: string }
  | { type: "inquiries"; page: number }
  | { type: "unknown"; raw: string };

export function parseToken(data?: string): ParsedToken {
  if (typeof data !== "string") {
    return { type: "unknown", raw: "" };
  }

  const byteLen = Buffer.byteLength(data, "utf8");
  if (byteLen < 1 || byteLen > TELEGRAM_MAX_CALLBACK_DATA_BYTES) {
    return { type: "unknown", raw: data };
  }

  if (data === "home") {
    return { type: "home" };
  }

  if (data === "home:new") {
    return { type: "homeNew" };
  }

  if (data === "cart") {
    return { type: "cart" };
  }

  if (data.startsWith("ca:")) {
    const parts = data.slice(3).split(":");
    if (
      parts.length === 2 &&
      UUID_REGEX.test(parts[0]) &&
      /^[1-9][0-9]?$/.test(parts[1])
    ) {
      return {
        type: "cartAdd",
        productId: parts[0],
        quantity: parseInt(parts[1], 10),
      };
    }
    return { type: "unknown", raw: data };
  }

  if (data.startsWith("ci:")) {
    const productId = data.slice(3);
    return UUID_REGEX.test(productId)
      ? { type: "cartIncrease", productId }
      : { type: "unknown", raw: data };
  }

  if (data.startsWith("cd:")) {
    const productId = data.slice(3);
    return UUID_REGEX.test(productId)
      ? { type: "cartDecrease", productId }
      : { type: "unknown", raw: data };
  }

  if (data.startsWith("cr:")) {
    const productId = data.slice(3);
    return UUID_REGEX.test(productId)
      ? { type: "cartRemove", productId }
      : { type: "unknown", raw: data };
  }

  if (data.startsWith("co:")) {
    const cartId = data.slice(3);
    return UUID_REGEX.test(cartId)
      ? { type: "checkout", cartId }
      : { type: "unknown", raw: data };
  }

  if (data.startsWith("cc:")) {
    const parts = data.slice(3).split(":");
    if (
      parts.length === 2 &&
      UUID_REGEX.test(parts[0]) &&
      PAGE_REGEX.test(parts[1])
    ) {
      return {
        type: "confirmCod",
        cartId: parts[0],
        quoteVersion: parseInt(parts[1], 10),
      };
    }
    return { type: "unknown", raw: data };
  }

  if (data.startsWith("cv:")) {
    const parts = data.slice(3).split(":");
    if (
      parts.length === 2 &&
      UUID_REGEX.test(parts[0]) &&
      PAGE_REGEX.test(parts[1])
    ) {
      return {
        type: "confirmVodafoneCash",
        cartId: parts[0],
        quoteVersion: parseInt(parts[1], 10),
      };
    }
    return { type: "unknown", raw: data };
  }

  if (data.startsWith("cb:")) {
    const cartId = data.slice(3);
    return UUID_REGEX.test(cartId)
      ? { type: "backToCart", cartId }
      : { type: "unknown", raw: data };
  }

  if (data.startsWith("tr:")) {
    const orderId = data.slice(3);
    return UUID_REGEX.test(orderId)
      ? { type: "transferReference", orderId }
      : { type: "unknown", raw: data };
  }

  if (data === "tfl") {
    return { type: "transferList" };
  }

  if (data.startsWith("tfo:")) {
    const orderId = data.slice(4);
    return UUID_REGEX.test(orderId)
      ? { type: "transferOrder", orderId }
      : { type: "unknown", raw: data };
  }

  if (data === "langs") {
    return { type: "languages", context: null };
  }

  if (data.startsWith("langs:")) {
    const context = data.slice(6);
    return LANGUAGE_CONTEXT_PATTERN.test(context)
      ? { type: "languages", context }
      : { type: "unknown", raw: data };
  }

  if (data === "support") {
    return { type: "support" };
  }

  if (data === "scats") {
    return { type: "storefrontCategories", page: 1 };
  }

  if (data.startsWith("scats:")) {
    const pageStr = data.slice(6);
    if (PAGE_REGEX.test(pageStr)) {
      return { type: "storefrontCategories", page: parseInt(pageStr, 10) };
    }
    return { type: "unknown", raw: data };
  }

  if (data.startsWith("sc:")) {
    const parts = data.slice(3).split(":");
    const categoryId = parts[0];

    if (!UUID_REGEX.test(categoryId)) {
      return { type: "unknown", raw: data };
    }

    if (parts.length === 1) {
      return { type: "storefrontCategory", categoryId, page: 1 };
    }
    if (parts.length === 2 && PAGE_REGEX.test(parts[1])) {
      return {
        type: "storefrontCategory",
        categoryId,
        page: parseInt(parts[1], 10),
      };
    }

    return { type: "unknown", raw: data };
  }

  if (data === "prods") {
    return { type: "products", page: 1 };
  }

  if (data.startsWith("prods:")) {
    const pageStr = data.slice(6);
    if (PAGE_REGEX.test(pageStr)) {
      return { type: "products", page: parseInt(pageStr, 10) };
    }
    return { type: "unknown", raw: data };
  }

  if (data === "myinq") {
    return { type: "myInquiries", page: 1 };
  }

  if (data.startsWith("myinq:")) {
    const pageStr = data.slice(6);
    if (PAGE_REGEX.test(pageStr)) {
      return { type: "myInquiries", page: parseInt(pageStr, 10) };
    }
    return { type: "unknown", raw: data };
  }

  if (data === "inq") {
    return { type: "inquiries", page: 1 };
  }

  if (data.startsWith("inq:")) {
    const pageStr = data.slice(4);
    if (PAGE_REGEX.test(pageStr)) {
      return { type: "inquiries", page: parseInt(pageStr, 10) };
    }
    return { type: "unknown", raw: data };
  }

  if (data.startsWith("lang:")) {
    const parts = data.slice(5).split(":");
    const code = parts[0];

    if (!LANG_CODE_REGEX.test(code)) {
      return { type: "unknown", raw: data };
    }

    if (parts.length === 1) {
      return { type: "lang", code, context: null };
    }

    const context = parts.slice(1).join(":");
    return LANGUAGE_CONTEXT_PATTERN.test(context)
      ? { type: "lang", code, context }
      : { type: "unknown", raw: data };
  }

  if (data.startsWith("c:")) {
    const parts = data.slice(2).split(":");
    const target = parts[0];

    // Root catalog pagination
    if (target === "root") {
      if (parts.length === 1) {
        return { type: "root", page: 1 };
      }
      if (parts.length === 2 && PAGE_REGEX.test(parts[1])) {
        return { type: "root", page: parseInt(parts[1], 10) };
      }
      return { type: "unknown", raw: data };
    }

    if (!UUID_REGEX.test(target)) {
      return { type: "unknown", raw: data };
    }

    if (parts.length === 1) {
      return { type: "category", categoryId: target, page: 1 };
    }
    if (parts.length === 2 && PAGE_REGEX.test(parts[1])) {
      return { type: "category", categoryId: target, page: parseInt(parts[1], 10) };
    }

    return { type: "unknown", raw: data };
  }

  if (data.startsWith("pi:")) {
    const productId = data.slice(3);
    if (!UUID_REGEX.test(productId)) {
      return { type: "unknown", raw: data };
    }
    return { type: "productInquiry", productId };
  }

  if (data.startsWith("p:")) {
    const productId = data.slice(2);
    if (!UUID_REGEX.test(productId)) {
      return { type: "unknown", raw: data };
    }
    return { type: "product", productId };
  }

  if (data.startsWith("a:")) {
    const actionId = data.slice(2);
    if (!UUID_REGEX.test(actionId)) {
      return { type: "unknown", raw: data };
    }
    return { type: "action", actionId };
  }

  if (data.startsWith("pm:")) {
    const actionId = data.slice(3);
    if (!UUID_REGEX.test(actionId)) {
      return { type: "unknown", raw: data };
    }
    return { type: "paymentContact", actionId };
  }

  if (data.startsWith("m:")) {
    const parts = data.slice(2).split(":");
    const actionId = parts[0];

    if (!UUID_REGEX.test(actionId)) {
      return { type: "unknown", raw: data };
    }

    if (parts.length === 1) {
      return { type: "submenu", actionId, page: 1 };
    }
    if (parts.length === 2 && PAGE_REGEX.test(parts[1])) {
      return { type: "submenu", actionId, page: parseInt(parts[1], 10) };
    }

    return { type: "unknown", raw: data };
  }

  if (data.startsWith("b:")) {
    const actionId = data.slice(2);
    if (!UUID_REGEX.test(actionId)) {
      return { type: "unknown", raw: data };
    }
    return { type: "back", actionId };
  }

  return { type: "unknown", raw: data };
}
