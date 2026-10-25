/**
 * Action-Message Template Parsing and Interpolation Module (DATA_MODEL.md §5.2, §7).
 *
 * Provides safe, pure parsing, validation, and single-pass interpolation for
 * SEND_TEMPLATE_MESSAGE action buttons.
 *
 * Distinct from global bot message templates:
 * - Stored per-action on `product_action_translation.template_body`.
 * - Supported placeholders: {{store_name}}, {{product_name}}, {{customer_name}}, {{price}}.
 * - Does not alter or expand the 7 global bot message templates or their permissions.
 * - Interpolation is single-pass and strictly non-recursive.
 * - HTML and Telegram parse modes are excluded (pure plain text).
 */

import {
  ACTION_MESSAGE_PLACEHOLDERS,
  DEFAULT_ACTION_SAMPLE_CONTEXT,
  MAX_ACTION_TEMPLATE_BODY_LENGTH,
  type ActionMessagePlaceholder,
} from "./constants";

export interface ActionTemplateValidationResult {
  readonly success: boolean;
  readonly data?: string;
  readonly error?: string;
  readonly placeholders?: ActionMessagePlaceholder[];
}

/**
 * Counts Unicode code points (characters), matching PostgreSQL length() behaviour.
 */
function countCharacters(str: string): number {
  return Array.from(str).length;
}

/**
 * Validates an action message template body.
 *
 * Requirements:
 * 1. Non-empty when required (e.g. for default language or explicit non-empty optional language).
 * 2. Stored length <= 4096 characters (Telegram message bound).
 * 3. Double-brace syntax:
 *    - Strict {{identifier}} format (lowercase letters and underscores only).
 *    - Reject triple or nested braces ({{{...}}}).
 *    - Reject unclosed or stray braces.
 *    - Reject unknown placeholders.
 * 4. Rendered preview length using sample values <= 4096 characters.
 */
export function validateActionTemplateBody(
  raw: unknown,
  options?: {
    required?: boolean;
    languageLabel?: string;
    sampleContext?: Record<string, string>;
    skipPreviewLengthCheck?: boolean;
  },
): ActionTemplateValidationResult {
  const languageLabel = options?.languageLabel ?? "the selected language";
  const required = options?.required ?? false;

  if (raw === undefined || raw === null) {
    if (required) {
      return {
        success: false,
        error: `Message body in ${languageLabel} is required.`,
      };
    }
    return { success: true, data: "", placeholders: [] };
  }

  if (typeof raw !== "string") {
    return {
      success: false,
      error: `Message body in ${languageLabel} must be a string.`,
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    if (required) {
      return {
        success: false,
        error: `Message body in ${languageLabel} is required.`,
      };
    }
    return { success: true, data: "", placeholders: [] };
  }

  const charCount = countCharacters(trimmed);
  if (charCount > MAX_ACTION_TEMPLATE_BODY_LENGTH) {
    return {
      success: false,
      error: `Message body in ${languageLabel} must be ${MAX_ACTION_TEMPLATE_BODY_LENGTH} characters or fewer (currently ${charCount}).`,
    };
  }

  // Reject triple or nested braces immediately
  if (trimmed.includes("{{{") || trimmed.includes("}}}")) {
    return {
      success: false,
      error: "Malformed double-brace placeholder syntax: triple braces are not allowed.",
    };
  }

  // Match all double-brace expressions
  const doubleBraceRegex = /\{\{([^{}]*)\}\}/g;
  const matches = [...trimmed.matchAll(doubleBraceRegex)];

  // Strip all valid matches and verify no stray or unclosed braces remain
  const stripped = trimmed.replace(doubleBraceRegex, "");
  if (stripped.includes("{{") || stripped.includes("}}")) {
    return {
      success: false,
      error: "Malformed double-brace placeholder syntax: unclosed or stray braces detected.",
    };
  }

  const extractedPlaceholders: ActionMessagePlaceholder[] = [];

  for (const match of matches) {
    const rawInside = match[1];

    if (!/^[a-z_]+$/.test(rawInside)) {
      return {
        success: false,
        error: `Malformed placeholder identifier: "{{${rawInside}}}". Placeholders cannot contain spaces or special characters.`,
      };
    }

    const placeholder = rawInside as ActionMessagePlaceholder;
    if (!(ACTION_MESSAGE_PLACEHOLDERS as readonly string[]).includes(placeholder)) {
      const allowed = ACTION_MESSAGE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ");
      return {
        success: false,
        error: `Unknown placeholder "{{${placeholder}}}". Allowed placeholders: ${allowed}.`,
      };
    }

    if (!extractedPlaceholders.includes(placeholder)) {
      extractedPlaceholders.push(placeholder);
    }
  }

  // Preview length validation
  if (!options?.skipPreviewLengthCheck) {
    const previewContext = {
      ...DEFAULT_ACTION_SAMPLE_CONTEXT,
      ...(options?.sampleContext ?? {}),
    };
    const preview = interpolateActionTemplate(trimmed, previewContext);
    const previewCount = countCharacters(preview);
    if (previewCount > MAX_ACTION_TEMPLATE_BODY_LENGTH) {
      return {
        success: false,
        error: `Rendered preview exceeds ${MAX_ACTION_TEMPLATE_BODY_LENGTH} characters when sample values are substituted (currently ${previewCount}).`,
      };
    }
  }

  return {
    success: true,
    data: trimmed,
    placeholders: extractedPlaceholders,
  };
}

/**
 * Single-pass, non-recursive placeholder interpolation for action messages.
 * Values inside context are never re-scanned or evaluated.
 */
export function interpolateActionTemplate(
  body: string,
  context: Record<string, string> = DEFAULT_ACTION_SAMPLE_CONTEXT,
): string {
  if (!body) return "";

  return body.replace(/\{\{([a-z_]+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      return context[key];
    }
    return match;
  });
}
