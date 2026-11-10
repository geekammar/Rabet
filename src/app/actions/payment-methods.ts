"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  createPaymentMethod,
  editPaymentMethod,
  listLanguages,
  listPaymentMethods,
  type PaymentMethodRecord,
  RabetDataError,
  resolveDefaultLanguage,
  toSafeErrorMessage,
} from "@/lib/data";
import { validateBoolean, validateUuid } from "@/lib/product-actions/validation";

import {
  validateAdminLabel,
  validatePaymentInstructions,
  validatePaymentTitle,
} from "@/lib/payment-methods/validation";

export type PaymentMethodActionResult = {
  success: boolean;
  message?: string;
  code?: string;
  errors?: Record<string, string>;
  methodId?: string;
  method?: PaymentMethodRecord;
  methods?: PaymentMethodRecord[];
};

function extractField(source: unknown, field: string): unknown {
  if (typeof FormData !== "undefined" && source instanceof FormData) {
    if (!source.has(field)) return undefined;
    return source.get(field);
  }
  if (typeof source === "object" && source !== null) {
    return (source as Record<string, unknown>)[field];
  }
  return undefined;
}

/**
 * Loads all central payment methods.
 */
export async function loadPaymentMethodsAction(): Promise<PaymentMethodActionResult> {
  await requireAdmin();

  try {
    const db = getDb();
    const methods = await listPaymentMethods(db);
    return {
      success: true,
      methods,
    };
  } catch (error) {
    return {
      success: false,
      code: error instanceof RabetDataError ? error.code : "DATABASE_ERROR",
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Server action to create a new central payment method.
 * Methods default to disabled (isActive = false).
 */
export async function createPaymentMethodAction(
  input:
    | FormData
    | {
        adminLabel: unknown;
        isActive?: unknown;
        title: unknown;
        instructions?: unknown;
        arabicTitle?: unknown;
        arabicInstructions?: unknown;
      },
): Promise<PaymentMethodActionResult> {
  await requireAdmin();

  const rawAdminLabel = extractField(input, "adminLabel");
  const rawIsActive = extractField(input, "isActive");
  const rawTitle = extractField(input, "title");
  const rawInstructions = extractField(input, "instructions");
  const rawArabicTitle = extractField(input, "arabicTitle");
  const rawArabicInstructions = extractField(input, "arabicInstructions");

  const errors: Record<string, string> = {};

  const adminLabelRes = validateAdminLabel(rawAdminLabel);
  if (!adminLabelRes.success) {
    errors.adminLabel = adminLabelRes.error;
  }

  let isActive = false;
  if (rawIsActive !== undefined && rawIsActive !== null) {
    const activeRes = validateBoolean(rawIsActive, "Active state");
    if (!activeRes.success) {
      errors.isActive = activeRes.error;
    } else {
      isActive = activeRes.data;
    }
  }

  const titleRes = validatePaymentTitle(rawTitle, "Default language");
  if (!titleRes.success) {
    errors.title = titleRes.error;
  }

  let instructions: string | null = null;
  const instRes = validatePaymentInstructions(rawInstructions, "Default language");
  if (!instRes.success) {
    errors.instructions = instRes.error;
  } else {
    instructions = instRes.data;
  }

  let arabicTitle: string | null = null;
  if (rawArabicTitle !== undefined && rawArabicTitle !== null && String(rawArabicTitle).trim().length > 0) {
    const arTitleRes = validatePaymentTitle(rawArabicTitle, "Arabic");
    if (!arTitleRes.success) {
      errors.arabicTitle = arTitleRes.error;
    } else {
      arabicTitle = arTitleRes.data;
    }
  }

  let arabicInstructions: string | null = null;
  if (rawArabicInstructions !== undefined && rawArabicInstructions !== null) {
    const arInstRes = validatePaymentInstructions(rawArabicInstructions, "Arabic");
    if (!arInstRes.success) {
      errors.arabicInstructions = arInstRes.error;
    } else {
      arabicInstructions = arInstRes.data;
    }
  }

  if (arabicInstructions && !arabicTitle) {
    errors.arabicTitle = "Arabic title is required when Arabic instructions are provided.";
  }

  if (Object.keys(errors).length > 0 || !adminLabelRes.success || !titleRes.success) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Please correct the errors in the form.",
      errors,
    };
  }

  try {
    const db = getDb();
    const [languages, defaultLanguage] = await Promise.all([
      listLanguages(db),
      resolveDefaultLanguage(db),
    ]);

    const defaultLangId = defaultLanguage?.id;
    const defaultLangCode = defaultLanguage?.code;
    if (!defaultLangId || !defaultLangCode) {
      return {
        success: false,
        code: "SETTINGS_NOT_INITIALIZED",
        message: "Store default language is not configured. Please complete store setup in Settings.",
      };
    }

    const translationsToInsert = [
      {
        languageId: defaultLangId,
        languageCode: defaultLangCode,
        title: titleRes.data,
        instructions,
      },
    ];

    if (arabicTitle && defaultLangCode !== "ar") {
      const arabicLang = languages.find((l) => l.code === "ar");
      if (!arabicLang) {
        return {
          success: false,
          code: "NOT_FOUND",
          message: "Arabic is not a registered language in this store.",
          errors: { arabicTitle: "Arabic is not registered in this store." },
        };
      }
      translationsToInsert.push({
        languageId: arabicLang.id,
        languageCode: "ar",
        title: arabicTitle,
        instructions: arabicInstructions,
      });
    }

    const result = await createPaymentMethod(db, {
      adminLabel: adminLabelRes.data,
      isActive,
      translations: translationsToInsert,
    });

    revalidatePath("/payment-methods");
    revalidatePath("/settings");
    revalidatePath("/catalog");

    return {
      success: true,
      methodId: result.methodId,
      method: result.method,
      message: "Payment method created successfully.",
    };
  } catch (error) {
    return {
      success: false,
      code: error instanceof RabetDataError ? error.code : "DATABASE_ERROR",
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Server action to update a central payment method.
 */
export async function updatePaymentMethodAction(
  input:
    | FormData
    | {
        id: unknown;
        adminLabel?: unknown;
        isActive?: unknown;
        languageCode?: unknown;
        title?: unknown;
        instructions?: unknown;
      },
): Promise<PaymentMethodActionResult> {
  await requireAdmin();

  const rawId = extractField(input, "id");
  const rawAdminLabel = extractField(input, "adminLabel");
  const rawIsActive = extractField(input, "isActive");
  const rawLangCode = extractField(input, "languageCode");
  const rawTitle = extractField(input, "title");
  const rawInstructions = extractField(input, "instructions");

  const errors: Record<string, string> = {};

  const idRes = validateUuid(rawId, "Payment method ID");
  if (!idRes.success) {
    errors.id = idRes.error;
  }

  let adminLabel: string | undefined = undefined;
  if (rawAdminLabel !== undefined) {
    const labelRes = validateAdminLabel(rawAdminLabel);
    if (!labelRes.success) {
      errors.adminLabel = labelRes.error;
    } else {
      adminLabel = labelRes.data;
    }
  }

  let isActive: boolean | undefined = undefined;
  if (rawIsActive !== undefined && rawIsActive !== null) {
    const activeRes = validateBoolean(rawIsActive, "Active state");
    if (!activeRes.success) {
      errors.isActive = activeRes.error;
    } else {
      isActive = activeRes.data;
    }
  }

  const isTranslationSubmitted = rawTitle !== undefined || rawInstructions !== undefined;
  let langCode: string | undefined = undefined;
  let title: string | undefined = undefined;
  let instructions: string | null | undefined = undefined;

  if (isTranslationSubmitted) {
    if (typeof rawLangCode !== "string" || rawLangCode.trim().length === 0) {
      errors.languageCode = "Language code is required when updating translations.";
    } else {
      langCode = rawLangCode.trim().toLowerCase();
    }

    const langLabel = langCode ? langCode.toUpperCase() : "the selected language";

    if (rawTitle !== undefined) {
      const titleRes = validatePaymentTitle(rawTitle, langLabel);
      if (!titleRes.success) {
        errors.title = titleRes.error;
      } else {
        title = titleRes.data;
      }
    }

    if (rawInstructions !== undefined) {
      const instRes = validatePaymentInstructions(rawInstructions, langLabel);
      if (!instRes.success) {
        errors.instructions = instRes.error;
      } else {
        instructions = instRes.data;
      }
    }
  }

  if (Object.keys(errors).length > 0 || !idRes.success) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Please correct the errors in the form.",
      errors,
    };
  }

  try {
    const db = getDb();
    const languages = await listLanguages(db);

    let translationToUpdate:
      | {
          languageId: string;
          languageCode: string;
          title: string;
          instructions?: string | null;
        }
      | undefined = undefined;

    if (isTranslationSubmitted && langCode && title) {
      const targetLang = languages.find((l) => l.code === langCode);
      if (!targetLang) {
        return {
          success: false,
          code: "NOT_FOUND",
          message: `Language "${langCode}" is not registered in this store.`,
          errors: { languageCode: `Language "${langCode}" is not registered.` },
        };
      }
      translationToUpdate = {
        languageId: targetLang.id,
        languageCode: targetLang.code,
        title,
        instructions: instructions === undefined ? undefined : instructions,
      };
    }

    const result = await editPaymentMethod(db, {
      id: idRes.data,
      adminLabel,
      isActive,
      translation: translationToUpdate,
    });

    revalidatePath("/payment-methods");
    revalidatePath("/settings");
    revalidatePath("/catalog");

    return {
      success: true,
      method: result.method,
      message: "Payment method updated successfully.",
    };
  } catch (error) {
    return {
      success: false,
      code: error instanceof RabetDataError ? error.code : "DATABASE_ERROR",
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Server action to toggle a payment method between active and disabled.
 */
export async function togglePaymentMethodActiveAction(
  id: unknown,
  isActive: unknown,
): Promise<PaymentMethodActionResult> {
  await requireAdmin();

  const idRes = validateUuid(id, "Payment method ID");
  if (!idRes.success) {
    return { success: false, code: "INVALID_INPUT", message: idRes.error };
  }

  const activeRes = validateBoolean(isActive, "Active state");
  if (!activeRes.success) {
    return { success: false, code: "INVALID_INPUT", message: activeRes.error };
  }

  try {
    const db = getDb();
    const result = await editPaymentMethod(db, {
      id: idRes.data,
      isActive: activeRes.data,
    });

    revalidatePath("/payment-methods");
    revalidatePath("/settings");
    revalidatePath("/catalog");

    return {
      success: true,
      method: result.method,
      message: activeRes.data
        ? "Payment method enabled."
        : "Payment method disabled.",
    };
  } catch (error) {
    return {
      success: false,
      code: error instanceof RabetDataError ? error.code : "DATABASE_ERROR",
      message: toSafeErrorMessage(error),
    };
  }
}
