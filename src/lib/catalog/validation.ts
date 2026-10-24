/**
 * Pure catalog validation rules.
 *
 * Enforces:
 * - Slugs: trimmed, lowercase, valid character set (alphanumeric, dots, hyphens, underscores), max 100 chars.
 * - Names: trimmed, non-empty for default language, max 255 chars.
 * - Descriptions: optional, max 4096 chars.
 * - Details: optional, max 4096 chars.
 * - Prices: exact decimal compatible with PostgreSQL numeric(18,2).
 *   Rejects negative prices, exponent notation, excessive decimal places (>2),
 *   and out-of-range precision. Zero is valid. Never uses floating-point arithmetic.
 */

export const MAX_SLUG_LENGTH = 100;
export const MAX_NAME_LENGTH = 255;
export const MAX_TEXT_LENGTH = 4096;
export const MAX_PRICE_INTEGER_DIGITS = 16; // 16 integer + 2 fractional = 18 digits (numeric(18,2))

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SLUG_REGEX = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i;

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Validates a standard UUID string.
 */
export function validateUuid(
  raw: unknown,
  fieldName = "ID",
): ValidationResult<string> {
  if (typeof raw !== "string" || !UUID_REGEX.test(raw.trim())) {
    return {
      success: false,
      error: `${fieldName} must be a valid UUID.`,
    };
  }
  return { success: true, data: raw.trim().toLowerCase() };
}

/**
 * Validates a category or product slug.
 *
 * Slugs are stable keys e.g. "design.websites.landing" or "t-shirt-blue".
 */
export function validateSlug(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string") {
    return { success: false, error: "Slug must be a string." };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { success: false, error: "Slug is required." };
  }

  if (trimmed.length > MAX_SLUG_LENGTH) {
    return {
      success: false,
      error: `Slug must be ${MAX_SLUG_LENGTH} characters or fewer.`,
    };
  }

  if (!SLUG_REGEX.test(trimmed)) {
    return {
      success: false,
      error:
        "Slug must consist of letters, numbers, hyphens, underscores, or periods, and cannot start or end with a separator.",
    };
  }

  return { success: true, data: trimmed.toLowerCase() };
}

/**
 * Validates a localized entity name.
 */
export function validateName(
  raw: unknown,
  languageLabel = "the required language",
): ValidationResult<string> {
  if (typeof raw !== "string") {
    return {
      success: false,
      error: `Name in ${languageLabel} must be a string.`,
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      success: false,
      error: `Name in ${languageLabel} is required.`,
    };
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    return {
      success: false,
      error: `Name in ${languageLabel} must be ${MAX_NAME_LENGTH} characters or fewer.`,
    };
  }

  return { success: true, data: trimmed };
}

/**
 * Validates optional description text.
 */
export function validateDescription(
  raw: unknown,
  languageLabel = "the selected language",
): ValidationResult<string | null> {
  if (raw === undefined || raw === null) {
    return { success: true, data: null };
  }

  if (typeof raw !== "string") {
    return {
      success: false,
      error: `Description in ${languageLabel} must be a string.`,
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { success: true, data: null };
  }

  if (trimmed.length > MAX_TEXT_LENGTH) {
    return {
      success: false,
      error: `Description in ${languageLabel} must be ${MAX_TEXT_LENGTH} characters or fewer.`,
    };
  }

  return { success: true, data: trimmed };
}

/**
 * Validates optional product details text.
 */
export function validateDetails(
  raw: unknown,
  languageLabel = "the selected language",
): ValidationResult<string | null> {
  if (raw === undefined || raw === null) {
    return { success: true, data: null };
  }

  if (typeof raw !== "string") {
    return {
      success: false,
      error: `Details in ${languageLabel} must be a string.`,
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { success: true, data: null };
  }

  if (trimmed.length > MAX_TEXT_LENGTH) {
    return {
      success: false,
      error: `Details in ${languageLabel} must be ${MAX_TEXT_LENGTH} characters or fewer.`,
    };
  }

  return { success: true, data: trimmed };
}

/**
 * Validates and normalizes a displayed price for PostgreSQL numeric(18,2).
 *
 * Rules:
 * - Rejects non-string / non-numeric inputs.
 * - Rejects exponent notation (e/E).
 * - Rejects negative values.
 * - Rejects more than 2 decimal places (never silently rounds).
 * - Rejects out-of-range values (> 16 integer digits).
 * - Zero is valid ("0", "0.0", "0.00").
 * - Returns exact decimal string with 2 decimal places (e.g. "25.00").
 * - NO floating-point arithmetic is used.
 */
export function validatePrice(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string") {
    return {
      success: false,
      error: "Price must be a string representing an exact decimal value.",
    };
  }

  const str = raw.trim();
  if (str.length === 0) {
    return { success: false, error: "Price is required." };
  }

  // Reject exponent / scientific notation
  if (/[eE]/.test(str)) {
    return {
      success: false,
      error: "Price cannot use scientific or exponent notation.",
    };
  }

  // Reject negative
  if (str.startsWith("-")) {
    return { success: false, error: "Price cannot be negative." };
  }

  // Reject anything that is not digits and at most one decimal point
  if (!/^\d+(\.\d+)?$/.test(str)) {
    return {
      success: false,
      error: "Price must be a valid non-negative decimal number.",
    };
  }

  const [intPartRaw, decPartRaw] = str.split(".");

  // Reject excessive decimal places (must be at most 2)
  if (decPartRaw !== undefined && decPartRaw.length > 2) {
    return {
      success: false,
      error: "Price cannot have more than 2 decimal places.",
    };
  }

  // Strip leading zeros for integer part length check, except for single "0"
  const intPartClean = intPartRaw.replace(/^0+(?=\d)/, "");

  if (intPartClean.length > MAX_PRICE_INTEGER_DIGITS) {
    return {
      success: false,
      error: `Price integer part cannot exceed ${MAX_PRICE_INTEGER_DIGITS} digits.`,
    };
  }

  // Exact string format with 2 decimal places without float rounding
  const intPart = intPartClean.length === 0 ? "0" : intPartClean;
  const decPart = (decPartRaw ?? "").padEnd(2, "0");
  const normalizedPrice = `${intPart}.${decPart}`;

  return { success: true, data: normalizedPrice };
}

/**
 * Validates a boolean value strictly from an action payload or checkbox.
 * Rejects undefined, null, numbers, or malformed strings.
 */
export function validateBoolean(
  raw: unknown,
  fieldName = "Field",
): ValidationResult<boolean> {
  if (typeof raw === "boolean") {
    return { success: true, data: raw };
  }
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "on") {
      return { success: true, data: true };
    }
    if (lower === "false" || lower === "0" || lower === "off") {
      return { success: true, data: false };
    }
  }
  return {
    success: false,
    error: `${fieldName} must be a valid boolean.`,
  };
}
