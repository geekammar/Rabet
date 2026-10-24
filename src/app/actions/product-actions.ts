"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  createProductAction,
  editProductAction,
  listLanguages,
  listProductActions,
  type ProductActionRecord,
  RabetDataError,
  resolveDefaultLanguage,
  toSafeErrorMessage,
} from "@/lib/data";
import {
  validateActionLabel,
  validateActionMenuText,
  validateActionParameters,
  validateActionType,
  validateBoolean,
  validateUuid,
} from "@/lib/product-actions/validation";

export type ProductActionResult = {
  success: boolean;
  message?: string;
  code?: string;
  errors?: Record<string, string>;
  actionId?: string;
  action?: ProductActionRecord;
  actions?: ProductActionRecord[];
};

export type CreateProductActionInput =
  | FormData
  | {
      productId: unknown;
      parentActionId?: unknown;
      actionType: unknown;
      isActive?: unknown;
      label: unknown;
      menuText?: unknown;
      arabicLabel?: unknown;
      arabicMenuText?: unknown;
      url?: unknown;
      navigateCategoryId?: unknown;
      navigateProductId?: unknown;
      actionConfig?: unknown;
    };

export type UpdateProductActionInput =
  | FormData
  | {
      actionId: unknown;
      productId: unknown;
      actionType: unknown;
      isActive: unknown;
      languageCode?: unknown;
      label?: unknown;
      menuText?: unknown;
      url?: unknown;
      navigateCategoryId?: unknown;
      navigateProductId?: unknown;
      actionConfig?: unknown;
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
 * Loads all product actions for a given product.
 */
export async function loadProductActionsAction(
  productIdInput: unknown,
): Promise<ProductActionResult> {
  await requireAdmin();

  const prodIdRes = validateUuid(productIdInput, "Product ID");
  if (!prodIdRes.success) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: prodIdRes.error,
    };
  }

  try {
    const db = getDb();
    const actions = await listProductActions(db, prodIdRes.data);
    return {
      success: true,
      actions,
    };
  } catch (error) {
    return {
      success: false,
      code: error instanceof RabetDataError ? error.code : "DATABASE_ERROR",
      message:
        error instanceof RabetDataError && error.code === "NOT_FOUND"
          ? error.message
          : toSafeErrorMessage(error),
    };
  }
}

/**
 * Server action to create a new product action.
 */
export async function createProductActionAction(
  input: CreateProductActionInput,
): Promise<ProductActionResult> {
  // 1. Authoritative admin boundary check
  await requireAdmin();

  // 2. Extract fields
  const isFormData = typeof FormData !== "undefined" && input instanceof FormData;
  const rawProductId = extractField(input, "productId");
  const rawParentActionId = extractField(input, "parentActionId");
  const rawActionType = extractField(input, "actionType");
  const rawIsActive = extractField(input, "isActive");
  const rawLabel = extractField(input, "label");
  const rawMenuText = extractField(input, "menuText");
  const rawArabicLabel = extractField(input, "arabicLabel");
  const rawArabicMenuText = extractField(input, "arabicMenuText");
  const rawUrl = extractField(input, "url");
  const rawNavCat = extractField(input, "navigateCategoryId");
  const rawNavProd = extractField(input, "navigateProductId");
  const rawConfig = extractField(input, "actionConfig");

  const errors: Record<string, string> = {};

  // 3. Validate structural inputs
  const prodIdRes = validateUuid(rawProductId, "Product ID");
  if (!prodIdRes.success) {
    errors.productId = prodIdRes.error;
  }

  let parentActionId: string | null = null;
  if (
    rawParentActionId !== undefined &&
    rawParentActionId !== null &&
    String(rawParentActionId).trim().length > 0
  ) {
    const parentRes = validateUuid(rawParentActionId, "Parent button ID");
    if (!parentRes.success) {
      errors.parentActionId = parentRes.error;
    } else {
      parentActionId = parentRes.data;
    }
  }

  const typeRes = validateActionType(rawActionType);
  if (!typeRes.success) {
    errors.actionType = typeRes.error;
  }

  let isActive = true;
  if (rawIsActive !== undefined && rawIsActive !== null) {
    const activeRes = validateBoolean(rawIsActive, "Active state");
    if (!activeRes.success) {
      errors.isActive = activeRes.error;
    } else {
      isActive = activeRes.data;
    }
  }

  let label = "";
  const labelRes = validateActionLabel(rawLabel, "Default language");
  if (!labelRes.success) {
    errors.label = labelRes.error;
  } else {
    label = labelRes.data;
  }

  let menuText: string | null = null;
  const menuTextRes = validateActionMenuText(rawMenuText, "Default language");
  if (!menuTextRes.success) {
    errors.menuText = menuTextRes.error;
  } else {
    menuText = menuTextRes.data;
  }

  // Optional Arabic
  let arabicLabel: string | null = null;
  if (
    rawArabicLabel !== undefined &&
    rawArabicLabel !== null &&
    String(rawArabicLabel).trim().length > 0
  ) {
    const arLabelRes = validateActionLabel(rawArabicLabel, "Arabic");
    if (!arLabelRes.success) {
      errors.arabicLabel = arLabelRes.error;
    } else {
      arabicLabel = arLabelRes.data;
    }
  }

  let arabicMenuText: string | null = null;
  const arMenuTextRes = validateActionMenuText(rawArabicMenuText, "Arabic");
  if (!arMenuTextRes.success) {
    errors.arabicMenuText = arMenuTextRes.error;
  } else {
    arabicMenuText = arMenuTextRes.data;
  }

  if (arabicMenuText && !arabicLabel) {
    errors.arabicLabel = "Arabic button label is required when Arabic submenu message is provided.";
  }

  if (typeRes.success) {
    const paramRes = validateActionParameters({
      actionType: typeRes.data,
      menuText,
      arabicMenuText,
      url: rawUrl,
      navigateCategoryId: rawNavCat,
      navigateProductId: rawNavProd,
      actionConfig: rawConfig,
      isFormData,
    });
    if (!paramRes.success) {
      errors.parameters = paramRes.error;
    }
  }

  if (Object.keys(errors).length > 0 || !prodIdRes.success || !typeRes.success) {
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

    if (defaultLangCode === "ar" && arabicLabel) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "The store's default language is already Arabic; do not submit redundant Arabic fields.",
        errors: { arabicLabel: "Store default language is already Arabic." },
      };
    }

    const translationsToInsert = [
      {
        languageId: defaultLangId,
        languageCode: defaultLangCode,
        label,
        menuText,
      },
    ];

    if (arabicLabel && defaultLangCode !== "ar") {
      const arabicLang = languages.find((l) => l.code === "ar");
      if (!arabicLang) {
        return {
          success: false,
          code: "NOT_FOUND",
          message: "Arabic is not a registered language in this store.",
          errors: { arabicLabel: "Arabic is not registered in this store." },
        };
      }
      translationsToInsert.push({
        languageId: arabicLang.id,
        languageCode: "ar",
        label: arabicLabel,
        menuText: arabicMenuText,
      });
    }

    const result = await createProductAction(db, {
      productId: prodIdRes.data,
      parentActionId,
      actionType: typeRes.data!,
      isActive,
      translations: translationsToInsert,
    });

    revalidatePath("/catalog");

    return {
      success: true,
      actionId: result.actionId,
      action: result.action,
      message: "Button created successfully.",
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
 * Server action to update a product action.
 */
export async function updateProductActionAction(
  input: UpdateProductActionInput,
): Promise<ProductActionResult> {
  // 1. Authoritative admin boundary check
  await requireAdmin();

  // 2. Extract fields
  const isFormData = typeof FormData !== "undefined" && input instanceof FormData;
  const rawActionId = extractField(input, "actionId");
  const rawProductId = extractField(input, "productId");
  const rawActionType = extractField(input, "actionType");
  const rawIsActive = extractField(input, "isActive");
  const rawLangCode = extractField(input, "languageCode");
  const rawLabel = extractField(input, "label");
  const rawMenuText = extractField(input, "menuText");
  const rawUrl = extractField(input, "url");
  const rawNavCat = extractField(input, "navigateCategoryId");
  const rawNavProd = extractField(input, "navigateProductId");
  const rawConfig = extractField(input, "actionConfig");

  const errors: Record<string, string> = {};

  const actionIdRes = validateUuid(rawActionId, "Action ID");
  if (!actionIdRes.success) {
    errors.actionId = actionIdRes.error;
  }

  const prodIdRes = validateUuid(rawProductId, "Product ID");
  if (!prodIdRes.success) {
    errors.productId = prodIdRes.error;
  }

  const typeRes = validateActionType(rawActionType);
  if (!typeRes.success) {
    errors.actionType = typeRes.error;
  }

  const activeRes = validateBoolean(rawIsActive, "Active state");
  if (!activeRes.success) {
    errors.isActive = activeRes.error;
  }

  const isTranslationSubmitted =
    rawLabel !== undefined || rawMenuText !== undefined;

  let langCode: string | undefined;
  let label: string | undefined;
  let menuText: string | null | undefined = undefined;

  if (isTranslationSubmitted) {
    if (typeof rawLangCode !== "string" || rawLangCode.trim().length === 0) {
      errors.languageCode = "Language code is required when updating translations.";
    } else {
      langCode = rawLangCode.trim().toLowerCase();
      if (langCode !== "en" && langCode !== "ar") {
        errors.languageCode = `Language '${langCode}' is not supported by the action editor.`;
      }
    }

    const langLabel = langCode ? langCode.toUpperCase() : "the selected language";

    if (rawLabel === undefined) {
      errors.label = `Button label in ${langLabel} is required when updating translations.`;
    } else {
      const labelRes = validateActionLabel(rawLabel, langLabel);
      if (!labelRes.success) {
        errors.label = labelRes.error;
      } else {
        label = labelRes.data;
      }
    }

    if (rawMenuText === undefined) {
      menuText = undefined;
    } else if (
      rawMenuText === null ||
      (typeof rawMenuText === "string" && rawMenuText.trim().length === 0)
    ) {
      menuText = null;
    } else {
      const menuRes = validateActionMenuText(rawMenuText, langLabel);
      if (!menuRes.success) {
        errors.menuText = menuRes.error;
      } else {
        menuText = menuRes.data;
      }
    }

    if (typeRes.success && typeRes.data !== "OPEN_SUBMENU") {
      if (menuText !== undefined && menuText !== null && menuText.trim().length > 0) {
        errors.menuText = `Submenu message is only permitted on OPEN_SUBMENU actions, not on ${typeRes.data}.`;
      }
    }
  }

  if (typeRes.success) {
    const paramRes = validateActionParameters({
      actionType: typeRes.data,
      menuText: isTranslationSubmitted && typeof menuText === "string" ? menuText : null,
      url: rawUrl,
      navigateCategoryId: rawNavCat,
      navigateProductId: rawNavProd,
      actionConfig: rawConfig,
      isFormData,
    });
    if (!paramRes.success) {
      errors.parameters = paramRes.error;
    }
  }

  if (
    Object.keys(errors).length > 0 ||
    !actionIdRes.success ||
    !prodIdRes.success ||
    !typeRes.success ||
    !activeRes.success
  ) {
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
          label: string;
          menuText?: string | null;
        }
      | undefined;

    if (isTranslationSubmitted) {
      if (!langCode || !label) {
        return {
          success: false,
          code: "INVALID_INPUT",
          message: "Please correct the errors in the form.",
          errors,
        };
      }

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
        label,
        menuText: menuText === undefined ? undefined : menuText,
      };
    }

    const result = await editProductAction(db, {
      actionId: actionIdRes.data,
      productId: prodIdRes.data,
      actionType: typeRes.data!,
      isActive: activeRes.data!,
      translation: translationToUpdate,
    });

    revalidatePath("/catalog");

    return {
      success: true,
      action: result.action,
      message: "Button updated successfully.",
    };
  } catch (error) {
    return {
      success: false,
      code: error instanceof RabetDataError ? error.code : "DATABASE_ERROR",
      message: toSafeErrorMessage(error),
    };
  }
}
