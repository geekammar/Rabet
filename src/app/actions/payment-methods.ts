"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  checkPaymentMethodsCapability,
  createPaymentMethod,
  editPaymentMethod,
  listLanguages,
  listPaymentMethods,
  RabetDataError,
  readPaymentMethod,
  resolveDefaultLanguage,
  toSafeErrorMessage,
  type PaymentMethodRecord,
} from "@/lib/data";
import { validateBoolean, validateUuid } from "@/lib/product-actions/validation";

import {
  validateAdminLabel,
  validatePaymentInstructions,
  validatePaymentTitle,
} from "@/lib/payment-methods/validation";

export interface PaymentMethodActionResult {
  success: boolean;
  methodId?: string;
  method?: PaymentMethodRecord;
  methods?: PaymentMethodRecord[];
  code?: string;
  message?: string;
  errors?: Record<string, string>;
}

function extractField(input: unknown, field: string): unknown {
  if (input instanceof FormData) {
    return input.get(field) ?? undefined;
  }
  if (input && typeof input === "object" && field in input) {
    return (input as Record<string, unknown>)[field];
  }
  return undefined;
}

/**
 * Server action to fetch all central payment methods.
 * Protected by requireAdmin().
 */
export async function loadPaymentMethodsAction(): Promise<PaymentMethodActionResult> {
  await requireAdmin();

  try {
    const db = getDb();
    const capability = await checkPaymentMethodsCapability(db);
    if (!capability.supported) {
      return {
        success: true,
        methods: [],
      };
    }

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
        title?: unknown;
        instructions?: unknown;
        arabicTitle?: unknown;
        arabicInstructions?: unknown;
        translations?: Array<{
          languageCode: unknown;
          title?: unknown;
          instructions?: unknown;
        }>;
      },
): Promise<PaymentMethodActionResult> {
  await requireAdmin();

  const rawAdminLabel = extractField(input, "adminLabel");
  const rawIsActive = extractField(input, "isActive");
  const rawTitle = extractField(input, "title");
  const rawInstructions = extractField(input, "instructions");
  const rawArabicTitle = extractField(input, "arabicTitle");
  const rawArabicInstructions = extractField(input, "arabicInstructions");
  const rawTranslations = extractField(input, "translations");

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

  try {
    const db = getDb();
    const capability = await checkPaymentMethodsCapability(db);
    if (!capability.supported) {
      return {
        success: false,
        code: "SCHEMA_UPGRADE_REQUIRED",
        message: capability.reason ?? "Payment methods feature requires pending migration 0002_payment_methods.",
      };
    }

    const [languages, defaultLanguage] = await Promise.all([
      listLanguages(db),
      resolveDefaultLanguage(db),
    ]);

    const defaultCode = (defaultLanguage?.code ?? "en").toLowerCase();

    // Collect translations to create
    const translationsToCreate: Array<{
      languageId: string;
      languageCode: string;
      title: string;
      instructions: string | null;
    }> = [];

    if (Array.isArray(rawTranslations) && rawTranslations.length > 0) {
      for (const t of rawTranslations) {
        if (!t || typeof t !== "object") continue;
        const code = String(extractField(t, "languageCode") ?? "").trim().toLowerCase();
        if (!code) continue;

        const lang = languages.find((l) => l.code.toLowerCase() === code);
        if (!lang) {
          errors[`lang_${code}`] = `Language "${code}" is not registered.`;
          continue;
        }

        const tTitle = extractField(t, "title");
        const tInstructions = extractField(t, "instructions");

        const hasTitle = tTitle !== undefined && tTitle !== null && String(tTitle).trim().length > 0;
        const hasInst = tInstructions !== undefined && tInstructions !== null && String(tInstructions).trim().length > 0;

        if (!hasTitle && !hasInst) {
          // Empty optional draft, ignore
          continue;
        }

        const titleRes = validatePaymentTitle(tTitle, lang.label);
        if (!titleRes.success) {
          errors[`title_${code}`] = titleRes.error;
        }

        let instructionsVal: string | null = null;
        if (tInstructions !== undefined && tInstructions !== null) {
          const instRes = validatePaymentInstructions(tInstructions, lang.label);
          if (!instRes.success) {
            errors[`instructions_${code}`] = instRes.error;
          } else {
            instructionsVal = instRes.data;
          }
        }

        if (titleRes.success) {
          translationsToCreate.push({
            languageId: lang.id,
            languageCode: code,
            title: titleRes.data,
            instructions: instructionsVal,
          });
        }
      }
    } else {
      // Legacy single default language + optional Arabic form
      const titleRes = validatePaymentTitle(rawTitle, defaultLanguage?.label ?? "Default language");
      if (!titleRes.success) {
        errors.title = titleRes.error;
      }

      let instructions: string | null = null;
      const instRes = validatePaymentInstructions(rawInstructions, defaultLanguage?.label ?? "Default language");
      if (!instRes.success) {
        errors.instructions = instRes.error;
      } else {
        instructions = instRes.data;
      }

      if (titleRes.success && defaultLanguage) {
        translationsToCreate.push({
          languageId: defaultLanguage.id,
          languageCode: defaultCode,
          title: titleRes.data,
          instructions,
        });
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

      const arabicLang = languages.find((l) => l.code === "ar");
      if (arabicTitle && arabicLang && defaultCode !== "ar") {
        translationsToCreate.push({
          languageId: arabicLang.id,
          languageCode: "ar",
          title: arabicTitle,
          instructions: arabicInstructions,
        });
      }
    }

    const hasDefault = translationsToCreate.some((t) => t.languageCode === defaultCode);
    if (!hasDefault && !errors.title && !errors[`title_${defaultCode}`]) {
      errors.title = `A customer-facing title in the store's default language (${defaultCode.toUpperCase()}) is required.`;
    }

    if (Object.keys(errors).length > 0 || !adminLabelRes.success) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "Please correct the errors in the form.",
        errors,
      };
    }

    const result = await createPaymentMethod(db, {
      adminLabel: adminLabelRes.data,
      isActive,
      translations: translationsToCreate,
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
 * Supports updating multiple language drafts atomically in a single operation.
 * Partial updates preserve omitted fields.
 */
export async function updatePaymentMethodAction(
  input:
    | FormData
    | {
        id?: unknown;
        methodId?: unknown;
        adminLabel?: unknown;
        isActive?: unknown;
        languageCode?: unknown;
        title?: unknown;
        instructions?: unknown;
        translations?: Array<{
          languageCode: unknown;
          title?: unknown;
          instructions?: unknown;
        }>;
      },
): Promise<PaymentMethodActionResult> {
  await requireAdmin();

  const rawId = extractField(input, "id") ?? extractField(input, "methodId");
  const rawAdminLabel = extractField(input, "adminLabel");
  const rawIsActive = extractField(input, "isActive");
  const rawTranslations = extractField(input, "translations");

  const errors: Record<string, string> = {};

  const idRes = validateUuid(rawId, "Payment method ID");
  if (!idRes.success) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Please correct the errors in the form.",
      errors: { id: idRes.error },
    };
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

  try {
    const db = getDb();
    const capability = await checkPaymentMethodsCapability(db);
    if (!capability.supported) {
      return {
        success: false,
        code: "SCHEMA_UPGRADE_REQUIRED",
        message: capability.reason ?? "Payment methods feature requires pending migration 0002_payment_methods.",
      };
    }

    const existing = await readPaymentMethod(db, idRes.data);
    if (!existing) {
      return {
        success: false,
        code: "NOT_FOUND",
        message: "Payment method not found.",
      };
    }

    const languages = await listLanguages(db);
    const langByCode = new Map(languages.map((l) => [l.code.toLowerCase(), l]));

    // Normalize translations to update
    const translationsToUpdate: Array<{
      languageId: string;
      languageCode: string;
      title?: string;
      instructions?: string | null;
    }> = [];

    const validateTranslationCandidate = (
      code: string,
      rawTTitle: unknown,
      rawTInstructions: unknown,
      lang: { id: string; label: string; code: string },
      errorKeySuffix: string,
    ) => {
      const existingTrans = existing.translations[code];
      const isTitleProvided = rawTTitle !== undefined;
      const isInstProvided = rawTInstructions !== undefined;

      const trimmedTitle =
        rawTTitle !== undefined && rawTTitle !== null ? String(rawTTitle).trim() : undefined;
      const trimmedInst =
        rawTInstructions !== undefined && rawTInstructions !== null
          ? String(rawTInstructions).trim()
          : undefined;

      if (!existingTrans) {
        // Translation is NOT registered on the existing payment method (absent optional translation)
        const hasTitleContent = trimmedTitle !== undefined && trimmedTitle.length > 0;
        const hasInstContent = trimmedInst !== undefined && trimmedInst.length > 0;

        if (!hasTitleContent && !hasInstContent) {
          // Untouched, empty optional translation -> skip without error
          return;
        }

        if (hasInstContent && !hasTitleContent) {
          // Instructions entered for a new translation without a title MUST fail
          errors[`title${errorKeySuffix}`] =
            `Customer-facing title is required for a new translation in language ${code.toUpperCase()}.`;
          return;
        }

        // Title provided for new translation -> validate
        const titleRes = validatePaymentTitle(rawTTitle, lang.label);
        if (!titleRes.success) {
          errors[`title${errorKeySuffix}`] = titleRes.error;
        }

        let instructionsVal: string | null = null;
        if (isInstProvided && rawTInstructions !== null) {
          const instRes = validatePaymentInstructions(rawTInstructions, lang.label);
          if (!instRes.success) {
            errors[`instructions${errorKeySuffix}`] = instRes.error;
          } else {
            instructionsVal = instRes.data;
          }
        }

        if (
          titleRes.success &&
          (!isInstProvided || rawTInstructions === null || !errors[`instructions${errorKeySuffix}`])
        ) {
          translationsToUpdate.push({
            languageId: lang.id,
            languageCode: code,
            title: titleRes.data,
            instructions: instructionsVal,
          });
        }
      } else {
        // Translation EXISTS on the payment method
        let validatedTitle: string | undefined = undefined;
        let validatedInstructions: string | null | undefined = undefined;

        if (isTitleProvided) {
          if (trimmedTitle === undefined || trimmedTitle.length === 0) {
            // Explicitly clearing an existing title MUST fail
            errors[`title${errorKeySuffix}`] =
              `Customer-facing title cannot be empty for language ${code.toUpperCase()}.`;
          } else {
            const titleRes = validatePaymentTitle(rawTTitle, lang.label);
            if (!titleRes.success) {
              errors[`title${errorKeySuffix}`] = titleRes.error;
            } else {
              validatedTitle = titleRes.data;
            }
          }
        }

        if (isInstProvided) {
          if (rawTInstructions === null || trimmedInst === undefined || trimmedInst.length === 0) {
            // Explicitly clearing existing instructions is allowed and sets instructions to null
            validatedInstructions = null;
          } else {
            const instRes = validatePaymentInstructions(rawTInstructions, lang.label);
            if (!instRes.success) {
              errors[`instructions${errorKeySuffix}`] = instRes.error;
            } else {
              validatedInstructions = instRes.data;
            }
          }
        }

        if (
          (validatedTitle !== undefined || validatedInstructions !== undefined) &&
          !errors[`title${errorKeySuffix}`] &&
          !errors[`instructions${errorKeySuffix}`]
        ) {
          translationsToUpdate.push({
            languageId: lang.id,
            languageCode: code,
            title: validatedTitle,
            instructions: validatedInstructions,
          });
        }
      }
    };

    if (Array.isArray(rawTranslations)) {
      for (const t of rawTranslations) {
        if (!t || typeof t !== "object") continue;
        const code = String(extractField(t, "languageCode") ?? "").trim().toLowerCase();
        if (!code) continue;

        const lang = langByCode.get(code);
        if (!lang) {
          errors[`lang_${code}`] = `Language "${code}" is not registered.`;
          continue;
        }

        const rawTTitle = extractField(t, "title");
        const rawTInstructions = extractField(t, "instructions");

        validateTranslationCandidate(code, rawTTitle, rawTInstructions, lang, `_${code}`);
      }
    } else {
      // Single translation format
      const rawLangCode = extractField(input, "languageCode");
      const rawTitle = extractField(input, "title");
      const rawInstructions = extractField(input, "instructions");

      const isTranslationSubmitted = rawTitle !== undefined || rawInstructions !== undefined;
      if (isTranslationSubmitted) {
        if (typeof rawLangCode !== "string" || rawLangCode.trim().length === 0) {
          errors.languageCode = "Language code is required when updating translations.";
        } else {
          const code = rawLangCode.trim().toLowerCase();
          const lang = langByCode.get(code);
          if (!lang) {
            errors.languageCode = `Language "${code}" is not registered.`;
          } else {
            validateTranslationCandidate(code, rawTitle, rawInstructions, lang, "");
          }
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

    const result = await editPaymentMethod(db, {
      id: idRes.data,
      adminLabel,
      isActive,
      translations: translationsToUpdate,
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
 * Supports both togglePaymentMethodActiveAction(id, isActive) and
 * togglePaymentMethodActiveAction({ id, isActive }).
 */
export async function togglePaymentMethodActiveAction(
  idOrInput: unknown,
  maybeIsActive?: unknown,
): Promise<PaymentMethodActionResult> {
  await requireAdmin();

  let rawId: unknown;
  let rawIsActive: unknown;

  if (idOrInput && typeof idOrInput === "object" && !(idOrInput instanceof FormData)) {
    rawId = extractField(idOrInput, "id") ?? extractField(idOrInput, "methodId");
    rawIsActive = extractField(idOrInput, "isActive");
  } else {
    rawId = idOrInput;
    rawIsActive = maybeIsActive;
  }

  const idRes = validateUuid(rawId, "Payment method ID");
  if (!idRes.success) {
    return { success: false, code: "INVALID_INPUT", message: idRes.error };
  }

  const activeRes = validateBoolean(rawIsActive, "Active state");
  if (!activeRes.success) {
    return { success: false, code: "INVALID_INPUT", message: activeRes.error };
  }

  try {
    const db = getDb();
    const capability = await checkPaymentMethodsCapability(db);
    if (!capability.supported) {
      return {
        success: false,
        code: "SCHEMA_UPGRADE_REQUIRED",
        message: capability.reason ?? "Payment methods feature requires pending migration 0002_payment_methods.",
      };
    }

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
