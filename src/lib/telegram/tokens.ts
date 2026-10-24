/**
 * Compact self-scoping callback token contract for Telegram inline keyboards.
 *
 * All callback_data values are validated against Telegram's strict 1-64 byte limit
 * using UTF-8 byte length, not character count.
 */

export const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64;

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
  lang: (code: string): string => assertValidCallbackData(`lang:${code}`),
  category: (categoryId: string, page?: number): string =>
    assertValidCallbackData(
      page && page > 1 ? `c:${categoryId}:${page}` : `c:${categoryId}`,
    ),
  product: (productId: string): string =>
    assertValidCallbackData(`p:${productId}`),
  action: (actionId: string): string =>
    assertValidCallbackData(`a:${actionId}`),
  submenu: (actionId: string, page?: number): string =>
    assertValidCallbackData(
      page && page > 1 ? `m:${actionId}:${page}` : `m:${actionId}`,
    ),
  back: (actionId: string): string =>
    assertValidCallbackData(`b:${actionId}`),
};

export type ParsedToken =
  | { type: "home" }
  | { type: "lang"; code: string }
  | { type: "category"; categoryId: string; page: number }
  | { type: "product"; productId: string }
  | { type: "action"; actionId: string }
  | { type: "submenu"; actionId: string; page: number }
  | { type: "back"; actionId: string }
  | { type: "unknown"; raw: string };

export function parseToken(data?: string): ParsedToken {
  if (!data || typeof data !== "string") {
    return { type: "unknown", raw: "" };
  }

  if (data === "home") {
    return { type: "home" };
  }

  if (data.startsWith("lang:")) {
    return { type: "lang", code: data.slice(5) };
  }

  if (data.startsWith("c:")) {
    const parts = data.slice(2).split(":");
    const categoryId = parts[0];
    const page = parts[1] ? parseInt(parts[1], 10) : 1;
    return {
      type: "category",
      categoryId,
      page: Number.isNaN(page) ? 1 : Math.max(1, page),
    };
  }

  if (data.startsWith("p:")) {
    return { type: "product", productId: data.slice(2) };
  }

  if (data.startsWith("a:")) {
    return { type: "action", actionId: data.slice(2) };
  }

  if (data.startsWith("m:")) {
    const parts = data.slice(2).split(":");
    const actionId = parts[0];
    const page = parts[1] ? parseInt(parts[1], 10) : 1;
    return {
      type: "submenu",
      actionId,
      page: Number.isNaN(page) ? 1 : Math.max(1, page),
    };
  }

  if (data.startsWith("b:")) {
    return { type: "back", actionId: data.slice(2) };
  }

  return { type: "unknown", raw: data };
}
