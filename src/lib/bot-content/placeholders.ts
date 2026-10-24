/**
 * ===========================================================================
 * Bot Content Placeholders & Interpolation Module (DATA_MODEL.md §7).
 * ===========================================================================
 *
 * Provides pure, shared validation and interpolation logic for bot message
 * templates. This module is client-safe, free of side effects, and suitable for
 * reuse by both the admin editor and the future Telegram bot integration.
 *
 * Future Telegram Integration Contract:
 * -------------------------------------
 * 1. Template Text Delivery:
 *    - Handlers resolve message text via `resolveMessageText(db, { templateKey, languageCode })`.
 *    - If resolved, the handler interpolates contextual values using `interpolateTemplate(body, context)`.
 *    - All message bodies are plain text. Telegram Bot API `sendMessage` should be
 *      invoked with plain text (no parse_mode or escaped as plain text). Markdown
 *      or HTML parse modes are explicitly excluded in this phase to prevent injection.
 * 2. Newlines & Formatting:
 *    - Standard `\n` line breaks in the database body are preserved verbatim.
 * 3. Placeholders:
 *    - `{{store_name}}`: Replaced with store's display name from `bot_setting`.
 *    - `{{product_name}}`: Replaced with catalog item title from `product_translation`.
 *      Allowed strictly in `inquiry_received`.
 * 4. Safety Guarantee:
 *    - Interpolation is strictly single-pass and non-recursive. Values inside
 *      the context (e.g., store name containing `{{...}}`) are never re-evaluated.
 */

import {
  getTemplateDefinition,
  PlaceholderKey,
  TemplateKey,
} from "./registry";

/** All placeholder identifiers recognized anywhere across Rabet. */
export const ALL_KNOWN_PLACEHOLDERS: readonly PlaceholderKey[] = [
  "store_name",
  "product_name",
] as const;

/** Default sample values for live preview simulation. */
export const DEFAULT_SAMPLE_CONTEXT: Record<PlaceholderKey, string> = {
  store_name: "Acme Digital",
  product_name: "Premium Leather Bag",
} as const;

export type TemplateValidationResult =
  | {
      valid: true;
      placeholders: PlaceholderKey[];
    }
  | {
      valid: false;
      error: string;
    };

/**
 * Validates a message template body against strict bounds and placeholder rules:
 *
 * 1. Must be a non-empty string with non-whitespace content.
 * 2. Stored length must not exceed 4096 characters (Telegram message limit).
 * 3. Double-brace syntax must be well-formed:
 *    - No unclosed `{{` or stray `}}`.
 *    - No triple or nested braces (`{{{...}}}`).
 *    - No empty braces `{{}}` or whitespace `{{ store_name }}`.
 * 4. All placeholder identifiers must belong to `ALL_KNOWN_PLACEHOLDERS`.
 * 5. All placeholders used must be allowed for the specified `templateKey`.
 * 6. Interpolated preview text using sample context must also not exceed 4096 characters.
 */
export function validateTemplateBody(
  body: string,
  templateKey: TemplateKey,
  sampleContext: Record<string, string> = DEFAULT_SAMPLE_CONTEXT,
): TemplateValidationResult {
  if (typeof body !== "string" || body.trim().length === 0) {
    return {
      valid: false,
      error: "Message body is required.",
    };
  }

  const trimmed = body.trim();

  if (trimmed.length > 4096) {
    return {
      valid: false,
      error: "Message body is too long (4096 characters maximum).",
    };
  }

  // Reject triple or deeper braces immediately
  if (trimmed.includes("{{{") || trimmed.includes("}}}")) {
    return {
      valid: false,
      error: "Malformed double-brace placeholder syntax: triple braces are not allowed.",
    };
  }

  const templateDef = getTemplateDefinition(templateKey);
  if (!templateDef) {
    return {
      valid: false,
      error: `Unknown template key: "${templateKey}".`,
    };
  }

  // Find all double-brace expressions
  const doubleBraceRegex = /\{\{([^{}]*)\}\}/g;
  const matches = [...trimmed.matchAll(doubleBraceRegex)];

  // Strip all valid/matched `{{...}}` and check if any orphan `{{` or `}}` remain
  const stripped = trimmed.replace(doubleBraceRegex, "");
  if (stripped.includes("{{") || stripped.includes("}}")) {
    return {
      valid: false,
      error: "Malformed double-brace placeholder syntax: unclosed or stray braces detected.",
    };
  }

  const extractedPlaceholders: PlaceholderKey[] = [];

  for (const match of matches) {
    const rawInside = match[1];

    // Identifier must be non-empty, lowercase letters and underscores only, no whitespace
    if (!/^[a-z_]+$/.test(rawInside)) {
      return {
        valid: false,
        error: `Malformed placeholder identifier: "{{${rawInside}}}". Placeholders cannot contain spaces or special characters.`,
      };
    }

    const placeholder = rawInside as PlaceholderKey;

    if (!(ALL_KNOWN_PLACEHOLDERS as readonly string[]).includes(placeholder)) {
      return {
        valid: false,
        error: `Unknown placeholder: "{{${placeholder}}}".`,
      };
    }

    if (!templateDef.allowedPlaceholders.includes(placeholder)) {
      const allowedList = templateDef.allowedPlaceholders.map((p) => `{{${p}}}`).join(", ");
      return {
        valid: false,
        error: `Placeholder "{{${placeholder}}}" is not allowed in "${templateKey}". Allowed: ${allowedList || "none"}.`,
      };
    }

    if (!extractedPlaceholders.includes(placeholder)) {
      extractedPlaceholders.push(placeholder);
    }
  }

  // Validate preview output length
  const preview = interpolateTemplate(trimmed, sampleContext);
  if (preview.length > 4096) {
    return {
      valid: false,
      error: "Preview output exceeds 4096 characters when sample values are substituted.",
    };
  }

  return {
    valid: true,
    placeholders: extractedPlaceholders,
  };
}

/**
 * Interpolates template text with context values in a single pass.
 *
 * Guarantees NON-RECURSIVE interpretation: values inside `context` are never
 * rescanned or evaluated for placeholders.
 */
export function interpolateTemplate(
  body: string,
  context: Record<string, string> = DEFAULT_SAMPLE_CONTEXT,
): string {
  if (!body) return "";

  return body.replace(/\{\{([a-z_]+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      return context[key];
    }
    return match;
  });
}
