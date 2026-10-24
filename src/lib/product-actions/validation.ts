import {
  validateBoolean,
  validateUuid,
  type ValidationResult,
} from "@/lib/catalog/validation";
import {
  DEFERRED_ACTION_TYPES,
  MAX_ACTION_LABEL_LENGTH,
  MAX_ACTION_MENU_TEXT_LENGTH,
  SUPPORTED_ACTION_TYPES,
  type DeferredActionType,
  type SupportedActionType,
} from "./constants";

export { validateBoolean, validateUuid, type ValidationResult };

/**
 * Counts Unicode code points (characters), matching PostgreSQL length() behaviour
 * on multi-byte characters and surrogate pairs.
 */
export function countCharacters(str: string): number {
  return Array.from(str).length;
}

/**
 * Validates action type against the Phase 05-B1 narrow scope.
 * Accepts: OPEN_SUBMENU, SHOW_DETAILS, START_INQUIRY.
 * Distinguishes deferred approved types from arbitrary invalid inputs.
 */
export function validateActionType(raw: unknown): ValidationResult<SupportedActionType> {
  if (typeof raw !== "string") {
    return { success: false, error: "Action type must be a string." };
  }

  const trimmed = raw.trim();

  if (SUPPORTED_ACTION_TYPES.includes(trimmed as SupportedActionType)) {
    return { success: true, data: trimmed as SupportedActionType };
  }

  if (DEFERRED_ACTION_TYPES.includes(trimmed as DeferredActionType)) {
    return {
      success: false,
      error: `Action type "${trimmed}" is deferred and not supported in this release.`,
    };
  }

  return {
    success: false,
    error: `Invalid action type "${trimmed}". Must be one of: ${SUPPORTED_ACTION_TYPES.join(", ")}.`,
  };
}

/**
 * Validates a localized button label.
 * Must be non-empty, max 64 Unicode characters (PostgreSQL length check & Telegram button limit).
 */
export function validateActionLabel(
  raw: unknown,
  languageLabel = "the required language",
): ValidationResult<string> {
  if (typeof raw !== "string") {
    return {
      success: false,
      error: `Button label in ${languageLabel} must be a string.`,
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      success: false,
      error: `Button label in ${languageLabel} is required.`,
    };
  }

  const charCount = countCharacters(trimmed);
  if (charCount > MAX_ACTION_LABEL_LENGTH) {
    return {
      success: false,
      error: `Button label in ${languageLabel} must be ${MAX_ACTION_LABEL_LENGTH} characters or fewer (currently ${charCount}).`,
    };
  }

  return { success: true, data: trimmed };
}

/**
 * Validates optional menu text (message sent before submenu buttons).
 * Only valid for OPEN_SUBMENU. Max 4096 Unicode characters.
 */
export function validateActionMenuText(
  raw: unknown,
  languageLabel = "the selected language",
): ValidationResult<string | null> {
  if (raw === undefined || raw === null) {
    return { success: true, data: null };
  }

  if (typeof raw !== "string") {
    return {
      success: false,
      error: `Submenu message in ${languageLabel} must be a string.`,
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { success: true, data: null };
  }

  const charCount = countCharacters(trimmed);
  if (charCount > MAX_ACTION_MENU_TEXT_LENGTH) {
    return {
      success: false,
      error: `Submenu message in ${languageLabel} must be ${MAX_ACTION_MENU_TEXT_LENGTH} characters or fewer (currently ${charCount}).`,
    };
  }

  return { success: true, data: trimmed };
}

/**
 * Validates the actionConfig payload.
 * In Phase 05-B1, actionConfig may be omitted or the approved empty plain object {}.
 * Rejects nonempty objects, arrays, primitives, and arbitrary strings.
 * Explicitly parses and validates FormData representations (e.g. "" or "{}").
 */
export function validateActionConfig(
  raw: unknown,
  isFormData = false,
): ValidationResult<Record<string, never>> {
  if (raw === undefined || raw === null) {
    return { success: true, data: {} };
  }

  if (isFormData && typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === "{}") {
      return { success: true, data: {} };
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          Object.keys(parsed).length === 0
        ) {
          return { success: true, data: {} };
        }
      } catch {
        // parse failed
      }
    }
    return {
      success: false,
      error: "actionConfig must be an empty plain object or omitted.",
    };
  }

  if (typeof raw !== "object" || raw === null) {
    return {
      success: false,
      error: "actionConfig must be an empty plain object or omitted.",
    };
  }

  if (Array.isArray(raw)) {
    return {
      success: false,
      error: "actionConfig cannot be an array.",
    };
  }

  if (Object.prototype.toString.call(raw) !== "[object Object]") {
    return {
      success: false,
      error: "actionConfig must be a plain object.",
    };
  }

  if (Object.keys(raw as object).length > 0) {
    return {
      success: false,
      error: "Custom actionConfig properties are not supported in this slice.",
    };
  }

  return { success: true, data: {} };
}

/**
 * Validates incompatible parameters for the Phase 05-B1 action types.
 * Rejects menuText on terminal actions (in all submitted languages),
 * non-null URL or navigation targets, and invalid actionConfig.
 */
export function validateActionParameters(input: {
  actionType: SupportedActionType;
  menuText?: string | null;
  arabicMenuText?: string | null;
  url?: unknown;
  navigateCategoryId?: unknown;
  navigateProductId?: unknown;
  actionConfig?: unknown;
  isFormData?: boolean;
}): ValidationResult<void> {
  const isTerminal = input.actionType !== "OPEN_SUBMENU";

  if (isTerminal) {
    const hasDefaultMenuText =
      input.menuText !== undefined &&
      input.menuText !== null &&
      input.menuText.trim().length > 0;
    const hasArabicMenuText =
      input.arabicMenuText !== undefined &&
      input.arabicMenuText !== null &&
      input.arabicMenuText.trim().length > 0;

    if (hasDefaultMenuText || hasArabicMenuText) {
      return {
        success: false,
        error: `Submenu message is only permitted on OPEN_SUBMENU actions, not on ${input.actionType}.`,
      };
    }
  }

  if (input.url !== undefined && input.url !== null) {
    return {
      success: false,
      error: "URL configuration is not supported in this slice.",
    };
  }

  if (
    (input.navigateCategoryId !== undefined && input.navigateCategoryId !== null) ||
    (input.navigateProductId !== undefined && input.navigateProductId !== null)
  ) {
    return {
      success: false,
      error: "Catalog navigation configuration is not supported in this slice.",
    };
  }

  const configRes = validateActionConfig(input.actionConfig, input.isFormData);
  if (!configRes.success) {
    return {
      success: false,
      error: configRes.error,
    };
  }

  return { success: true, data: undefined };
}
