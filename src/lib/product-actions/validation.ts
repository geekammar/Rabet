import {
  validateBoolean,
  validateUuid,
  type ValidationResult,
} from "@/lib/catalog/validation";
import {
  MAX_ACTION_LABEL_LENGTH,
  MAX_ACTION_MENU_TEXT_LENGTH,
  SUPPORTED_ACTION_TYPES,
  type SupportedActionType,
} from "./constants";
import {
  interpolateActionTemplate,
  validateActionTemplateBody,
  type ActionTemplateValidationResult,
} from "./templates";

export {
  countCharacters,
  interpolateActionTemplate,
  validateActionTemplateBody,
  validateBoolean,
  validateUuid,
  type ActionTemplateValidationResult,
  type ValidationResult,
};

/**
 * Counts Unicode code points (characters), matching PostgreSQL length() behaviour
 * on multi-byte characters and surrogate pairs.
 */
function countCharacters(str: string): number {
  return Array.from(str).length;
}

/**
 * Validates action type against the complete set of approved action types.
 * Accepts: OPEN_SUBMENU, SHOW_DETAILS, START_INQUIRY, SEND_TEMPLATE_MESSAGE,
 *          OPEN_URL, OPEN_SUPPORT, NAVIGATE_CATALOG.
 */
export function validateActionType(raw: unknown): ValidationResult<SupportedActionType> {
  if (typeof raw !== "string") {
    return { success: false, error: "Action type must be a string." };
  }

  const trimmed = raw.trim();

  if (SUPPORTED_ACTION_TYPES.includes(trimmed as SupportedActionType)) {
    return { success: true, data: trimmed as SupportedActionType };
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
 * Validates an HTTPS URL for OPEN_URL using the WHATWG URL parser.
 *
 * Rules (DATA_MODEL.md §12.4):
 * - Absolute HTTPS URL (protocol === "https:")
 * - Valid hostname
 * - No embedded credentials (username / password)
 * - Reject javascript:, data:, file:, http: and malformed inputs
 * - No whitespace or control characters
 */
export function validateHttpsUrl(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string") {
    return { success: false, error: "URL must be a string." };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { success: false, error: "URL is required for OPEN_URL actions." };
  }

  // Reject whitespace or control characters
  if (/[\s\x00-\x1F\x7F]/.test(trimmed)) {
    return {
      success: false,
      error: "URL cannot contain spaces or control characters.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { success: false, error: "Invalid URL format." };
  }

  if (parsed.protocol !== "https:") {
    return {
      success: false,
      error: `URL must use the HTTPS protocol (https://). Received protocol "${parsed.protocol}".`,
    };
  }

  if (!parsed.hostname || parsed.hostname.length === 0) {
    return { success: false, error: "URL must have a valid hostname." };
  }

  if (parsed.username || parsed.password) {
    return {
      success: false,
      error: "URL cannot contain embedded credentials (username or password).",
    };
  }

  return { success: true, data: trimmed };
}

/**
 * Validates the actionConfig payload.
 *
 * - OPEN_SUPPORT: accepts {} or {"support_category": string}.
 * - All other action types: must be empty plain object {} or omitted.
 */
export function validateActionConfig(
  raw: unknown,
  actionTypeOrIsFormData: SupportedActionType | boolean = "OPEN_SUBMENU",
  isFormData = false,
  availableCategories?: string[],
): ValidationResult<Record<string, unknown>> {
  let actionType: SupportedActionType = "OPEN_SUBMENU";
  let formFlag = isFormData;

  if (typeof actionTypeOrIsFormData === "boolean") {
    formFlag = actionTypeOrIsFormData;
  } else if (typeof actionTypeOrIsFormData === "string") {
    actionType = actionTypeOrIsFormData;
  }

  let configObj: unknown = raw;

  if (configObj === undefined || configObj === null) {
    return { success: true, data: {} };
  }

  if (formFlag && typeof configObj === "string") {
    const trimmed = configObj.trim();
    if (trimmed.length === 0 || trimmed === "{}") {
      return { success: true, data: {} };
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        configObj = JSON.parse(trimmed);
      } catch {
        return {
          success: false,
          error: "actionConfig must be a valid JSON object or empty.",
        };
      }
    } else {
      return {
        success: false,
        error: "actionConfig must be a valid JSON object or empty.",
      };
    }
  }

  if (Array.isArray(configObj)) {
    return {
      success: false,
      error: "actionConfig cannot be an array.",
    };
  }

  if (typeof configObj !== "object" || configObj === null) {
    return {
      success: false,
      error:
        actionType === "OPEN_SUPPORT"
          ? "actionConfig must be a plain object."
          : "actionConfig must be an empty plain object or omitted.",
    };
  }

  if (Object.prototype.toString.call(configObj) !== "[object Object]") {
    return {
      success: false,
      error:
        actionType === "OPEN_SUPPORT"
          ? "actionConfig must be a plain object."
          : "actionConfig must be an empty plain object or omitted.",
    };
  }

  const keys = Object.keys(configObj as Record<string, unknown>);

  if (actionType !== "OPEN_SUPPORT") {
    if (keys.length > 0) {
      return {
        success: false,
        error: `Custom actionConfig properties are not supported on ${actionType}.`,
      };
    }
    return { success: true, data: {} };
  }

  // actionType === "OPEN_SUPPORT"
  if (keys.length === 0) {
    return { success: true, data: {} };
  }

  if (keys.length > 1 || keys[0] !== "support_category") {
    return {
      success: false,
      error: 'OPEN_SUPPORT actionConfig only accepts optional "support_category".',
    };
  }

  const categoryVal = (configObj as Record<string, unknown>).support_category;
  if (categoryVal === null || categoryVal === undefined || categoryVal === "") {
    return { success: true, data: {} };
  }

  if (typeof categoryVal !== "string") {
    return {
      success: false,
      error: "support_category in actionConfig must be a string.",
    };
  }

  const trimmedCat = categoryVal.trim();
  if (trimmedCat.length === 0 || trimmedCat.length > 60) {
    return {
      success: false,
      error: "support_category must be between 1 and 60 characters.",
    };
  }

  if (availableCategories && availableCategories.length > 0) {
    if (!availableCategories.includes(trimmedCat)) {
      return {
        success: false,
        error: `Support category "${trimmedCat}" is not configured in store settings.`,
      };
    }
  }

  return { success: true, data: { support_category: trimmedCat } };
}

/**
 * Validates incompatible parameters for all action types.
 *
 * Enforces type-specific contracts:
 * - OPEN_SUBMENU: accepts menuText; rejects url, targets, custom config, templateBody.
 * - SEND_TEMPLATE_MESSAGE: accepts templateBody; rejects menuText, url, targets, custom config.
 * - OPEN_URL: accepts url; rejects menuText, templateBody, targets, custom config.
 * - OPEN_SUPPORT: accepts optional support_category; rejects menuText, templateBody, url, targets.
 * - NAVIGATE_CATALOG: accepts exactly one target; rejects menuText, templateBody, url, custom config.
 * - SHOW_DETAILS / START_INQUIRY: rejects menuText, templateBody, url, targets, custom config.
 */
export function validateActionParameters(input: {
  actionType: SupportedActionType;
  menuText?: string | null;
  arabicMenuText?: string | null;
  templateBody?: string | null;
  arabicTemplateBody?: string | null;
  url?: unknown;
  navigateCategoryId?: unknown;
  navigateProductId?: unknown;
  actionConfig?: unknown;
  isFormData?: boolean;
  availableCategories?: string[];
}): ValidationResult<void> {
  const { actionType } = input;

  // 1. Submenu text: OPEN_SUBMENU only
  const hasMenuText =
    (input.menuText !== undefined &&
      input.menuText !== null &&
      input.menuText.trim().length > 0) ||
    (input.arabicMenuText !== undefined &&
      input.arabicMenuText !== null &&
      input.arabicMenuText.trim().length > 0);

  if (actionType !== "OPEN_SUBMENU" && hasMenuText) {
    return {
      success: false,
      error: `Submenu message is only permitted on OPEN_SUBMENU actions, not on ${actionType}.`,
    };
  }

  // 2. Template body: SEND_TEMPLATE_MESSAGE only
  const hasTemplateBody =
    (input.templateBody !== undefined &&
      input.templateBody !== null &&
      input.templateBody.trim().length > 0) ||
    (input.arabicTemplateBody !== undefined &&
      input.arabicTemplateBody !== null &&
      input.arabicTemplateBody.trim().length > 0);

  if (actionType !== "SEND_TEMPLATE_MESSAGE" && hasTemplateBody) {
    return {
      success: false,
      error: `Message body is only permitted on SEND_TEMPLATE_MESSAGE actions, not on ${actionType}.`,
    };
  }

  // 3. URL: OPEN_URL only
  const hasUrl =
    input.url !== undefined &&
    input.url !== null &&
    String(input.url).trim().length > 0;

  if (actionType !== "OPEN_URL" && hasUrl) {
    return {
      success: false,
      error: `URL configuration is only permitted on OPEN_URL actions, not on ${actionType}.`,
    };
  }

  // 4. Navigation targets: NAVIGATE_CATALOG only
  const hasNavCat =
    input.navigateCategoryId !== undefined &&
    input.navigateCategoryId !== null &&
    String(input.navigateCategoryId).trim().length > 0;

  const hasNavProd =
    input.navigateProductId !== undefined &&
    input.navigateProductId !== null &&
    String(input.navigateProductId).trim().length > 0;

  if (actionType !== "NAVIGATE_CATALOG" && (hasNavCat || hasNavProd)) {
    return {
      success: false,
      error: `Navigation targets are only permitted on NAVIGATE_CATALOG actions, not on ${actionType}.`,
    };
  }

  if (actionType === "NAVIGATE_CATALOG" && hasNavCat && hasNavProd) {
    return {
      success: false,
      error: "Cannot specify both a category and a product navigation target.",
    };
  }

  // 5. Config validation
  const configRes = validateActionConfig(
    input.actionConfig,
    actionType,
    input.isFormData,
    input.availableCategories,
  );
  if (!configRes.success) {
    return {
      success: false,
      error: configRes.error,
    };
  }

  return { success: true, data: undefined };
}
