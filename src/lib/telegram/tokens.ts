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
  rootCategory: (page?: number): string => {
    if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 99999)) {
      throw new Error(`Invalid page number: ${page}`);
    }
    return assertValidCallbackData(page && page > 1 ? `c:root:${page}` : "c:root");
  },
  lang: (code: string): string => {
    if (!LANG_CODE_REGEX.test(code)) {
      throw new Error(`Invalid language code format: "${code}"`);
    }
    return assertValidCallbackData(`lang:${code}`);
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
  action: (actionId: string): string => {
    if (!UUID_REGEX.test(actionId)) {
      throw new Error(`Invalid action UUID: "${actionId}"`);
    }
    return assertValidCallbackData(`a:${actionId}`);
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
};

export type ParsedToken =
  | { type: "home" }
  | { type: "root"; page: number }
  | { type: "lang"; code: string }
  | { type: "category"; categoryId: string; page: number }
  | { type: "product"; productId: string }
  | { type: "action"; actionId: string }
  | { type: "submenu"; actionId: string; page: number }
  | { type: "back"; actionId: string }
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

  if (data.startsWith("lang:")) {
    const code = data.slice(5);
    if (!LANG_CODE_REGEX.test(code)) {
      return { type: "unknown", raw: data };
    }
    return { type: "lang", code };
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
