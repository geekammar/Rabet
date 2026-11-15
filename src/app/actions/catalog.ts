"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  validateBoolean,
  validateDescription,
  validateDetails,
  validateName,
  validatePrice,
  validateSlug,
  validateUuid,
} from "@/lib/catalog/validation";
import { validateActionLabel } from "@/lib/product-actions/validation";
import {
  type CatalogCategoryRecord,
  type CatalogProductRecord,
  createCatalogCategory,
  createCatalogProduct,
  editCatalogCategory,
  editCatalogProduct,
  listLanguages,
  RabetDataError,
  resolveDefaultLanguage,
  toSafeErrorMessage,
} from "@/lib/data";

export type CatalogActionResult = {
  success: boolean;
  message?: string;
  code?: string;
  errors?: Record<string, string>;
  categoryId?: string;
  productId?: string;
  category?: CatalogCategoryRecord;
  product?: CatalogProductRecord;
};

export type CreateCategoryActionInput =
  | FormData
  | {
      parentId?: unknown;
      slug: unknown;
      name: unknown;
      description?: unknown;
      arabicName?: unknown;
      arabicDescription?: unknown;
    };

export type UpdateCategoryActionInput =
  | FormData
  | {
      categoryId: unknown;
      slug: unknown;
      isActive: unknown;
      languageCode?: unknown;
      name?: unknown;
      description?: unknown;
      translations?: unknown;
    };

export type CreateProductActionInput =
  | FormData
  | {
      categoryId: unknown;
      slug: unknown;
      price: unknown;
      name: unknown;
      description?: unknown;
      details?: unknown;
      arabicName?: unknown;
      arabicDescription?: unknown;
      arabicDetails?: unknown;
      allowInquiry?: unknown;
    };

export type UpdateProductActionInput =
  | FormData
  | {
      productId: unknown;
      categoryId?: unknown;
      slug: unknown;
      price: unknown;
      isActive: unknown;
      languageCode?: unknown;
      name?: unknown;
      description?: unknown;
      details?: unknown;
      translations?: unknown;
    };

function extractField(source: unknown, field: string): unknown {
  if (typeof FormData !== "undefined" && source instanceof FormData) {
    const val = source.get(field);
    return val === null ? undefined : val;
  }
  if (source && typeof source === "object") {
    return (source as Record<string, unknown>)[field];
  }
  return undefined;
}

function normalizeTranslationList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Creates a root or nested category with default language translation (and optional Arabic).
 */
export async function createCategoryAction(
  input: CreateCategoryActionInput,
): Promise<CatalogActionResult> {
  // 1. Authoritative admin boundary FIRST
  await requireAdmin();

  const rawParentId = extractField(input, "parentId");
  const rawSlug = extractField(input, "slug");
  const rawName = extractField(input, "name");
  const rawDescription = extractField(input, "description");
  const rawArabicName = extractField(input, "arabicName");
  const rawArabicDesc = extractField(input, "arabicDescription");

  const errors: Record<string, string> = {};

  // Validate Parent ID if supplied
  let parentId: string | null = null;
  if (
    rawParentId !== undefined &&
    rawParentId !== null &&
    String(rawParentId).trim().length > 0 &&
    String(rawParentId).trim() !== "root" &&
    String(rawParentId).trim() !== "none"
  ) {
    const parentRes = validateUuid(rawParentId, "Parent Category");
    if (!parentRes.success) {
      errors.parentId = parentRes.error;
    } else {
      parentId = parentRes.data;
    }
  }

  // Validate Slug
  const slugRes = validateSlug(rawSlug);
  let slug = "";
  if (!slugRes.success) {
    errors.slug = slugRes.error;
  } else {
    slug = slugRes.data;
  }

  // Validate Name for default language
  const nameRes = validateName(rawName, "Default language");
  let name = "";
  if (!nameRes.success) {
    errors.name = nameRes.error;
  } else {
    name = nameRes.data;
  }

  // Validate Description
  const descRes = validateDescription(rawDescription, "Default language");
  let description: string | null = null;
  if (!descRes.success) {
    errors.description = descRes.error;
  } else {
    description = descRes.data;
  }

  // Validate optional Arabic content
  let arabicName: string | null = null;
  if (
    rawArabicName !== undefined &&
    rawArabicName !== null &&
    String(rawArabicName).trim().length > 0
  ) {
    const arNameRes = validateName(rawArabicName, "Arabic");
    if (!arNameRes.success) {
      errors.arabicName = arNameRes.error;
    } else {
      arabicName = arNameRes.data;
    }
  }

  const arDescRes = validateDescription(rawArabicDesc, "Arabic");
  let arabicDescription: string | null = null;
  if (!arDescRes.success) {
    errors.arabicDescription = arDescRes.error;
  } else {
    arabicDescription = arDescRes.data;
  }

  if (Object.keys(errors).length > 0) {
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

    if (defaultLangCode === "ar" && arabicName) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "The store's default language is already Arabic; do not submit redundant Arabic fields.",
        errors: { arabicName: "Store default language is already Arabic." },
      };
    }

    const translationsToInsert = [
      {
        languageId: defaultLangId,
        name,
        description,
      },
    ];

    if (arabicName && defaultLangCode !== "ar") {
      const arabicLang = languages.find((l) => l.code === "ar");
      if (!arabicLang) {
        return {
          success: false,
          code: "NOT_FOUND",
          message: "Arabic is not a registered language in this store.",
          errors: { arabicName: "Arabic is not registered in this store." },
        };
      }
      translationsToInsert.push({
        languageId: arabicLang.id,
        name: arabicName,
        description: arabicDescription,
      });
    }

    const result = await createCatalogCategory(db, {
      parentId,
      slug,
      translations: translationsToInsert,
    });

    revalidatePath("/catalog");
    revalidatePath("/categories");
    revalidatePath("/products");
    return {
      success: true,
      categoryId: result.categoryId,
      category: result.category,
      message: "Category created successfully.",
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      if (error.code === "CONFLICT") {
        return {
          success: false,
          code: "CONFLICT",
          message:
            "A category with this slug or position already exists. Please choose a different slug or try again.",
          errors: { slug: "Slug is already in use." },
        };
      }
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }
    return {
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Updates category base fields (slug, isActive) and optionally saves translation for the specified language.
 * Uses atomic batch update to ensure base fields and translation commit or roll back together.
 */
export async function updateCategoryAction(
  input: UpdateCategoryActionInput,
): Promise<CatalogActionResult> {
  await requireAdmin();

  const rawCategoryId = extractField(input, "categoryId");
  const rawSlug = extractField(input, "slug");
  const rawIsActive = extractField(input, "isActive");
  const rawLanguageCode = extractField(input, "languageCode");
  const rawName = extractField(input, "name");
  const rawDescription = extractField(input, "description");
  const rawTranslations = extractField(input, "translations");

  const errors: Record<string, string> = {};

  const idRes = validateUuid(rawCategoryId, "Category ID");
  let categoryId = "";
  if (!idRes.success) {
    errors.categoryId = idRes.error;
  } else {
    categoryId = idRes.data;
  }

  const slugRes = validateSlug(rawSlug);
  let slug = "";
  if (!slugRes.success) {
    errors.slug = slugRes.error;
  } else {
    slug = slugRes.data;
  }

  const isActiveRes = validateBoolean(rawIsActive, "Active status");
  let isActive = false;
  if (!isActiveRes.success) {
    errors.isActive = isActiveRes.error;
  } else {
    isActive = isActiveRes.data;
  }

  const isMultiTranslationSubmitted = rawTranslations !== undefined;
  const multiTranslationCandidates: Array<{
    languageCode: string;
    name: string;
    description: string | null;
  }> = [];

  if (isMultiTranslationSubmitted) {
    const parsedTranslations = normalizeTranslationList(rawTranslations);

    if (parsedTranslations === null) {
      errors.translations = "Translations must be provided as a list.";
    } else {
      const seenLanguages = new Set<string>();

      for (const item of parsedTranslations) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          errors.translations = "Each translation must be an object.";
          break;
        }

        const record = item as Record<string, unknown>;
        const rawLanguageCode = record.languageCode;

        if (
          typeof rawLanguageCode !== "string" ||
          rawLanguageCode.trim().length === 0
        ) {
          errors.translations =
            "Each translation requires a language code.";
          continue;
        }

        const candidateLanguageCode = rawLanguageCode.trim().toLowerCase();
        if (
          candidateLanguageCode !== "en" &&
          candidateLanguageCode !== "ar"
        ) {
          errors[`translations.${candidateLanguageCode}`] =
            `Language '${candidateLanguageCode}' is not supported by the catalog editor.`;
          continue;
        }

        if (seenLanguages.has(candidateLanguageCode)) {
          errors[`translations.${candidateLanguageCode}`] =
            `Duplicate translation for '${candidateLanguageCode}'.`;
          continue;
        }
        seenLanguages.add(candidateLanguageCode);

        const languageLabel =
          candidateLanguageCode === "ar" ? "Arabic" : "English";
        const candidateNameRes = validateName(record.name, languageLabel);
        const candidateDescriptionRes = validateDescription(
          record.description,
          languageLabel,
        );

        if (!candidateNameRes.success) {
          errors[`translations.${candidateLanguageCode}.name`] =
            candidateNameRes.error;
        }
        if (!candidateDescriptionRes.success) {
          errors[`translations.${candidateLanguageCode}.description`] =
            candidateDescriptionRes.error;
        }

        if (candidateNameRes.success && candidateDescriptionRes.success) {
          multiTranslationCandidates.push({
            languageCode: candidateLanguageCode,
            name: candidateNameRes.data,
            description: candidateDescriptionRes.data,
          });
        }
      }
    }
  }

  // Translation update contract:
  // If either name or description is explicitly provided, validate as translation update.
  // If neither is provided, treat as base-only update.
  const isTranslationSubmitted =
    !isMultiTranslationSubmitted &&
    (rawName !== undefined || rawDescription !== undefined);

  let languageCode: string | null = null;
  let name: string | null = null;
  let description: string | null = null;

  if (isTranslationSubmitted) {
    if (typeof rawLanguageCode !== "string" || rawLanguageCode.trim().length === 0) {
      errors.languageCode = "Language code is required when updating translations.";
    } else {
      languageCode = rawLanguageCode.trim().toLowerCase();
      if (languageCode !== "en" && languageCode !== "ar") {
        errors.languageCode = `Language '${languageCode}' is not supported by the catalog editor.`;
      }
    }

    const langLabel = (languageCode ?? "the selected language").toUpperCase();
    const nameRes = validateName(rawName, langLabel);
    if (!nameRes.success) {
      errors.name = nameRes.error;
    } else {
      name = nameRes.data;
    }

    const descRes = validateDescription(rawDescription, langLabel);
    if (!descRes.success) {
      errors.description = descRes.error;
    } else {
      description = descRes.data;
    }
  }

  if (Object.keys(errors).length > 0) {
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

    let translationInput: {
      languageId: string;
      name: string;
      description?: string | null;
    } | null = null;

    let multiTranslationInput:
      | Array<{
          languageId: string;
          name: string;
          description?: string | null;
        }>
      | null = null;

    if (isTranslationSubmitted && languageCode && name) {
      const targetLanguage = languages.find((l) => l.code === languageCode);
      if (!targetLanguage) {
        return {
          success: false,
          code: "NOT_FOUND",
          message: `Language '${languageCode}' is not registered in this store.`,
          errors: { languageCode: `Language '${languageCode}' is not registered.` },
        };
      }
      translationInput = {
        languageId: targetLanguage.id,
        name,
        description,
      };
    }

    if (isMultiTranslationSubmitted) {
      const languageByCode = new Map(
        languages.map((languageRow) => [languageRow.code, languageRow]),
      );
      const resolvedTranslations: Array<{
        languageId: string;
        name: string;
        description?: string | null;
      }> = [];

      for (const candidate of multiTranslationCandidates) {
        const targetLanguage = languageByCode.get(candidate.languageCode);
        if (!targetLanguage) {
          return {
            success: false,
            code: "NOT_FOUND",
            message: `Language '${candidate.languageCode}' is not registered in this store.`,
            errors: {
              [`translations.${candidate.languageCode}`]:
                `Language '${candidate.languageCode}' is not registered.`,
            },
          };
        }

        resolvedTranslations.push({
          languageId: targetLanguage.id,
          name: candidate.name,
          description: candidate.description,
        });
      }

      multiTranslationInput = resolvedTranslations;
    }

    const result = await editCatalogCategory(db, {
      categoryId,
      slug,
      isActive,
      translation: translationInput,
      ...(multiTranslationInput ? { translations: multiTranslationInput } : {}),
    });

    revalidatePath("/catalog");
    revalidatePath("/categories");
    revalidatePath("/products");
    return {
      success: true,
      categoryId,
      category: result.category,
      message: "Category updated successfully.",
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      if (error.code === "CONFLICT") {
        return {
          success: false,
          code: "CONFLICT",
          message: "A category with this slug already exists. Please choose a different slug.",
          errors: { slug: "Slug is already in use." },
        };
      }
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }
    return {
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Creates a product in a category with default language translation (and optional Arabic).
 */
export async function createProductAction(
  input: CreateProductActionInput,
): Promise<CatalogActionResult> {
  await requireAdmin();

  const rawCategoryId = extractField(input, "categoryId");
  const rawSlug = extractField(input, "slug");
  const rawPrice = extractField(input, "price");
  const rawName = extractField(input, "name");
  const rawDescription = extractField(input, "description");
  const rawDetails = extractField(input, "details");
  const rawArabicName = extractField(input, "arabicName");
  const rawArabicDesc = extractField(input, "arabicDescription");
  const rawArabicDetails = extractField(input, "arabicDetails");
  const rawAllowInquiry = extractField(input, "allowInquiry");

  const errors: Record<string, string> = {};

  const catIdRes = validateUuid(rawCategoryId, "Category");
  let categoryId = "";
  if (!catIdRes.success) {
    errors.categoryId = catIdRes.error;
  } else {
    categoryId = catIdRes.data;
  }

  const slugRes = validateSlug(rawSlug);
  let slug = "";
  if (!slugRes.success) {
    errors.slug = slugRes.error;
  } else {
    slug = slugRes.data;
  }

  const priceRes = validatePrice(rawPrice);
  let price = "";
  if (!priceRes.success) {
    errors.price = priceRes.error;
  } else {
    price = priceRes.data;
  }

  const nameRes = validateName(rawName, "Default language");
  let name = "";
  if (!nameRes.success) {
    errors.name = nameRes.error;
  } else {
    name = nameRes.data;
  }

  const descRes = validateDescription(rawDescription, "Default language");
  let description: string | null = null;
  if (!descRes.success) {
    errors.description = descRes.error;
  } else {
    description = descRes.data;
  }

  const detailsRes = validateDetails(rawDetails, "Default language");
  let details: string | null = null;
  if (!detailsRes.success) {
    errors.details = detailsRes.error;
  } else {
    details = detailsRes.data;
  }

  let allowInquiry = false;
  if (rawAllowInquiry !== undefined && rawAllowInquiry !== null) {
    const inquiryRes = validateBoolean(rawAllowInquiry, "Allow customers to inquire");
    if (!inquiryRes.success) {
      errors.allowInquiry = inquiryRes.error;
    } else {
      allowInquiry = inquiryRes.data;
    }
  }

  // Optional Arabic
  let arabicName: string | null = null;
  if (
    rawArabicName !== undefined &&
    rawArabicName !== null &&
    String(rawArabicName).trim().length > 0
  ) {
    const arNameRes = validateName(rawArabicName, "Arabic");
    if (!arNameRes.success) {
      errors.arabicName = arNameRes.error;
    } else {
      arabicName = arNameRes.data;
    }
  }

  const arDescRes = validateDescription(rawArabicDesc, "Arabic");
  let arabicDesc: string | null = null;
  if (!arDescRes.success) {
    errors.arabicDescription = arDescRes.error;
  } else {
    arabicDesc = arDescRes.data;
  }

  const arDetailsRes = validateDetails(rawArabicDetails, "Arabic");
  let arabicDetails: string | null = null;
  if (!arDetailsRes.success) {
    errors.arabicDetails = arDetailsRes.error;
  } else {
    arabicDetails = arDetailsRes.data;
  }

  if (Object.keys(errors).length > 0) {
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

    if (defaultLangCode === "ar" && arabicName) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "The store's default language is already Arabic; do not submit redundant Arabic fields.",
        errors: { arabicName: "Store default language is already Arabic." },
      };
    }

    let defaultInquiry:
      | { translations: Array<{ languageId: string; label: string }> }
      | undefined;

    if (allowInquiry) {
      const defaultInquiryLabel =
        defaultLangCode === "ar" ? "اسأل عن هذا المنتج" : "Ask about this product";
      const labelRes = validateActionLabel(defaultInquiryLabel, "Default language");
      if (!labelRes.success) {
        return {
          success: false,
          code: "INVALID_INPUT",
          message: "Could not prepare the default inquiry button.",
          errors: { allowInquiry: labelRes.error },
        };
      }

      defaultInquiry = {
        translations: [
          {
            languageId: defaultLangId,
            label: labelRes.data,
          },
        ],
      };
    }

    const translationsToInsert = [
      {
        languageId: defaultLangId,
        name,
        description,
        details,
      },
    ];

    if (arabicName && defaultLangCode !== "ar") {
      const arabicLang = languages.find((l) => l.code === "ar");
      if (!arabicLang) {
        return {
          success: false,
          code: "NOT_FOUND",
          message: "Arabic is not a registered language in this store.",
          errors: { arabicName: "Arabic is not registered in this store." },
        };
      }
      translationsToInsert.push({
        languageId: arabicLang.id,
        name: arabicName,
        description: arabicDesc,
        details: arabicDetails,
      });
    }

    const result = await createCatalogProduct(db, {
      categoryId,
      slug,
      price,
      translations: translationsToInsert,
      defaultInquiry,
    });

    revalidatePath("/catalog");
    revalidatePath("/products");
    revalidatePath("/categories");
    return {
      success: true,
      productId: result.productId,
      product: result.product,
      message: "Product created successfully.",
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      if (error.code === "CONFLICT") {
        return {
          success: false,
          code: "CONFLICT",
          message: "A product with this slug already exists. Please choose a different slug.",
          errors: { slug: "Slug is already in use." },
        };
      }
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }
    return {
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Updates product base attributes (slug, price, isActive) and saves translation for the specified language.
 * Uses atomic batch update to ensure base attributes and translation commit or roll back together.
 */
export async function updateProductAction(
  input: UpdateProductActionInput,
): Promise<CatalogActionResult> {
  await requireAdmin();

  const rawProductId = extractField(input, "productId");
  const rawCategoryId = extractField(input, "categoryId");
  const rawSlug = extractField(input, "slug");
  const rawPrice = extractField(input, "price");
  const rawIsActive = extractField(input, "isActive");
  const rawLanguageCode = extractField(input, "languageCode");
  const rawName = extractField(input, "name");
  const rawDescription = extractField(input, "description");
  const rawDetails = extractField(input, "details");
  const rawTranslations = extractField(input, "translations");

  const errors: Record<string, string> = {};

  const idRes = validateUuid(rawProductId, "Product ID");
  let productId = "";
  if (!idRes.success) {
    errors.productId = idRes.error;
  } else {
    productId = idRes.data;
  }

  let categoryId: string | undefined;
  if (rawCategoryId !== undefined && rawCategoryId !== null) {
    const catIdRes = validateUuid(rawCategoryId, "Category");
    if (!catIdRes.success) {
      errors.categoryId = catIdRes.error;
    } else {
      categoryId = catIdRes.data;
    }
  }

  const slugRes = validateSlug(rawSlug);
  let slug = "";
  if (!slugRes.success) {
    errors.slug = slugRes.error;
  } else {
    slug = slugRes.data;
  }

  const priceRes = validatePrice(rawPrice);
  let price = "";
  if (!priceRes.success) {
    errors.price = priceRes.error;
  } else {
    price = priceRes.data;
  }

  const isActiveRes = validateBoolean(rawIsActive, "Active status");
  let isActive = false;
  if (!isActiveRes.success) {
    errors.isActive = isActiveRes.error;
  } else {
    isActive = isActiveRes.data;
  }

  const isMultiTranslationSubmitted = rawTranslations !== undefined;
  const multiTranslationCandidates: Array<{
    languageCode: string;
    name: string;
    description: string | null;
    details: string | null;
  }> = [];

  if (isMultiTranslationSubmitted) {
    const parsedTranslations = normalizeTranslationList(rawTranslations);

    if (parsedTranslations === null) {
      errors.translations = "Translations must be provided as a list.";
    } else {
      const seenLanguages = new Set<string>();

      for (const item of parsedTranslations) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          errors.translations = "Each translation must be an object.";
          break;
        }

        const record = item as Record<string, unknown>;
        const rawLanguageCode = record.languageCode;

        if (
          typeof rawLanguageCode !== "string" ||
          rawLanguageCode.trim().length === 0
        ) {
          errors.translations =
            "Each translation requires a language code.";
          continue;
        }

        const candidateLanguageCode = rawLanguageCode.trim().toLowerCase();
        if (
          candidateLanguageCode !== "en" &&
          candidateLanguageCode !== "ar"
        ) {
          errors[`translations.${candidateLanguageCode}`] =
            `Language '${candidateLanguageCode}' is not supported by the catalog editor.`;
          continue;
        }

        if (seenLanguages.has(candidateLanguageCode)) {
          errors[`translations.${candidateLanguageCode}`] =
            `Duplicate translation for '${candidateLanguageCode}'.`;
          continue;
        }
        seenLanguages.add(candidateLanguageCode);

        const languageLabel =
          candidateLanguageCode === "ar" ? "Arabic" : "English";
        const candidateNameRes = validateName(record.name, languageLabel);
        const candidateDescriptionRes = validateDescription(
          record.description,
          languageLabel,
        );
        const candidateDetailsRes = validateDetails(
          record.details,
          languageLabel,
        );

        if (!candidateNameRes.success) {
          errors[`translations.${candidateLanguageCode}.name`] =
            candidateNameRes.error;
        }
        if (!candidateDescriptionRes.success) {
          errors[`translations.${candidateLanguageCode}.description`] =
            candidateDescriptionRes.error;
        }
        if (!candidateDetailsRes.success) {
          errors[`translations.${candidateLanguageCode}.details`] =
            candidateDetailsRes.error;
        }

        if (
          candidateNameRes.success &&
          candidateDescriptionRes.success &&
          candidateDetailsRes.success
        ) {
          multiTranslationCandidates.push({
            languageCode: candidateLanguageCode,
            name: candidateNameRes.data,
            description: candidateDescriptionRes.data,
            details: candidateDetailsRes.data,
          });
        }
      }
    }
  }

  // Translation update contract:
  // If name, description, or details is explicitly provided, validate as translation update.
  // If none is provided, treat as base-only update.
  const isTranslationSubmitted =
    !isMultiTranslationSubmitted &&
    (rawName !== undefined || rawDescription !== undefined || rawDetails !== undefined);

  let languageCode: string | null = null;
  let name: string | null = null;
  let description: string | null = null;
  let details: string | null = null;

  if (isTranslationSubmitted) {
    if (typeof rawLanguageCode !== "string" || rawLanguageCode.trim().length === 0) {
      errors.languageCode = "Language code is required when updating translations.";
    } else {
      languageCode = rawLanguageCode.trim().toLowerCase();
      if (languageCode !== "en" && languageCode !== "ar") {
        errors.languageCode = `Language '${languageCode}' is not supported by the catalog editor.`;
      }
    }

    const langLabel = (languageCode ?? "the selected language").toUpperCase();
    const nameRes = validateName(rawName, langLabel);
    if (!nameRes.success) {
      errors.name = nameRes.error;
    } else {
      name = nameRes.data;
    }

    const descRes = validateDescription(rawDescription, langLabel);
    if (!descRes.success) {
      errors.description = descRes.error;
    } else {
      description = descRes.data;
    }

    const detailsRes = validateDetails(rawDetails, langLabel);
    if (!detailsRes.success) {
      errors.details = detailsRes.error;
    } else {
      details = detailsRes.data;
    }
  }

  if (Object.keys(errors).length > 0) {
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

    let translationInput: {
      languageId: string;
      name: string;
      description?: string | null;
      details?: string | null;
    } | null = null;

    let multiTranslationInput:
      | Array<{
          languageId: string;
          name: string;
          description?: string | null;
          details?: string | null;
        }>
      | null = null;

    if (isTranslationSubmitted && languageCode && name) {
      const targetLanguage = languages.find((l) => l.code === languageCode);
      if (!targetLanguage) {
        return {
          success: false,
          code: "NOT_FOUND",
          message: `Language '${languageCode}' is not registered in this store.`,
          errors: { languageCode: `Language '${languageCode}' is not registered.` },
        };
      }
      translationInput = {
        languageId: targetLanguage.id,
        name,
        description,
        details,
      };
    }

    if (isMultiTranslationSubmitted) {
      const languageByCode = new Map(
        languages.map((languageRow) => [languageRow.code, languageRow]),
      );
      const resolvedTranslations: Array<{
        languageId: string;
        name: string;
        description?: string | null;
        details?: string | null;
      }> = [];

      for (const candidate of multiTranslationCandidates) {
        const targetLanguage = languageByCode.get(candidate.languageCode);
        if (!targetLanguage) {
          return {
            success: false,
            code: "NOT_FOUND",
            message: `Language '${candidate.languageCode}' is not registered in this store.`,
            errors: {
              [`translations.${candidate.languageCode}`]:
                `Language '${candidate.languageCode}' is not registered.`,
            },
          };
        }

        resolvedTranslations.push({
          languageId: targetLanguage.id,
          name: candidate.name,
          description: candidate.description,
          details: candidate.details,
        });
      }

      multiTranslationInput = resolvedTranslations;
    }

    const result = await editCatalogProduct(db, {
      productId,
      ...(categoryId ? { categoryId } : {}),
      slug,
      price,
      isActive,
      translation: translationInput,
      ...(multiTranslationInput ? { translations: multiTranslationInput } : {}),
    });

    revalidatePath("/catalog");
    revalidatePath("/products");
    revalidatePath("/categories");
    return {
      success: true,
      productId,
      product: result.product,
      message: "Product updated successfully.",
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      if (error.code === "CONFLICT") {
        return {
          success: false,
          code: "CONFLICT",
          message: "A product with this slug already exists. Please choose a different slug.",
          errors: { slug: "Slug is already in use." },
        };
      }
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }
    return {
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: toSafeErrorMessage(error),
    };
  }
}
