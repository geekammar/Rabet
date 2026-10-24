"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  createTemplate,
  readLanguage,
  saveTranslation,
  toSafeErrorMessage,
} from "@/lib/data";
import {
  getTemplateDefinition,
  isApprovedTemplateKey,
  validateTemplateBody,
} from "@/lib/bot-content";

export type BotContentActionResult = {
  success: boolean;
  message?: string;
  code?: string;
  errors?: Record<string, string>;
};

export type SaveBotContentInput =
  | FormData
  | {
      templateKey: unknown;
      languageCode: unknown;
      body: unknown;
    };

/**
 * Saves one message translation for one approved template in one registered language.
 *
 * Contract:
 * 1. Checks requireAdmin() FIRST before any DB read or write.
 * 2. Validates fields, types, and double-brace placeholders before any write.
 * 3. Verifies that the language is registered in the database.
 * 4. Creates only the target template row if absent (idempotent, never touches other templates).
 * 5. Saves only the target translation row (upsert).
 * 6. Never enables or modifies languages, store settings, or unrelated templates.
 * 7. Reports failures honestly; never claims success if the translation write fails.
 */
export async function saveBotContentTranslation(
  input: SaveBotContentInput,
): Promise<BotContentActionResult> {
  // 1. Authoritative admin boundary check FIRST (ADR-010)
  await requireAdmin();

  // 2. Extract fields from FormData or structured input
  let rawKey: unknown;
  let rawLanguageCode: unknown;
  let rawBody: unknown;

  if (typeof FormData !== "undefined" && input instanceof FormData) {
    rawKey = input.get("templateKey");
    rawLanguageCode = input.get("languageCode");
    rawBody = input.get("body");
  } else if (typeof input === "object" && input !== null && "templateKey" in input) {
    const obj = input as { templateKey: unknown; languageCode: unknown; body: unknown };
    rawKey = obj.templateKey;
    rawLanguageCode = obj.languageCode;
    rawBody = obj.body;
  } else {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Malformed request payload.",
    };
  }

  // Reject file uploads or non-string types
  if (
    typeof rawKey !== "string" ||
    typeof rawLanguageCode !== "string" ||
    typeof rawBody !== "string"
  ) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Template key, language code, and message body must be text strings.",
    };
  }

  const templateKey = rawKey.trim();
  const languageCode = rawLanguageCode.trim().toLowerCase();
  const body = rawBody;

  // 3. Validate template key against the 7-key registry
  if (!isApprovedTemplateKey(templateKey)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: `"${templateKey}" is not an approved template key.`,
    };
  }

  const templateDef = getTemplateDefinition(templateKey);
  if (!templateDef) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: `Definition not found for template "${templateKey}".`,
    };
  }

  // 4. Validate language code format (two lowercase letters)
  if (!/^[a-z]{2}$/.test(languageCode)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Language code must be exactly two lowercase letters.",
    };
  }

  // 5. Validate body and placeholders
  const validation = validateTemplateBody(body, templateKey);
  if (!validation.valid) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: validation.error,
    };
  }

  // 6. Database operations
  const db = getDb();

  // Verify language is registered in the database
  const targetLanguage = await readLanguage(db, languageCode);
  if (!targetLanguage) {
    return {
      success: false,
      code: "LANGUAGE_NOT_FOUND",
      message: `Language "${languageCode}" is not registered. Please register it in Store Settings first.`,
    };
  }

  try {
    // Ensure template metadata row exists; idempotent, writes only this row
    await createTemplate(db, {
      key: templateDef.key,
      description: templateDef.purpose,
    });

    // Save the translation
    await saveTranslation(db, {
      templateKey: templateDef.key,
      languageCode: targetLanguage.code,
      body: body.trim(),
    });

    revalidatePath("/bot-content");

    return {
      success: true,
      message: "Template translation saved successfully.",
    };
  } catch (error) {
    return {
      success: false,
      code: "SAVE_FAILED",
      message: toSafeErrorMessage(error),
    };
  }
}
