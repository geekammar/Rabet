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
import {
  createCatalogCategory,
  createCatalogProduct,
  listLanguages,
  RabetDataError,
  resolveDefaultLanguage,
  saveCatalogCategoryTranslation,
  saveCatalogProductTranslation,
  toSafeErrorMessage,
  updateCatalogCategory,
  updateCatalogProduct,
} from "@/lib/data";

export type CatalogActionResult = {
  success: boolean;
  message?: string;
  code?: string;
  errors?: Record<string, string>;
  categoryId?: string;
  productId?: string;
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
    };

export type UpdateProductActionInput =
  | FormData
  | {
      productId: unknown;
      slug: unknown;
      price: unknown;
      isActive: unknown;
      languageCode?: unknown;
      name?: unknown;
      description?: unknown;
      details?: unknown;
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
    if (!defaultLangId) {
      return {
        success: false,
        code: "SETTINGS_NOT_INITIALIZED",
        message: "Store default language is not configured. Please complete store setup in Settings.",
      };
    }

    const translationsToInsert = [
      {
        languageId: defaultLangId,
        name,
        description,
      },
    ];

    if (arabicName) {
      const arabicLang = languages.find((l) => l.code === "ar");
      if (arabicLang) {
        translationsToInsert.push({
          languageId: arabicLang.id,
          name: arabicName,
          description: arabicDescription,
        });
      }
    }

    const result = await createCatalogCategory(db, {
      parentId,
      slug,
      translations: translationsToInsert,
    });

    revalidatePath("/catalog");
    return {
      success: true,
      categoryId: result.categoryId,
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

  const isActive = validateBoolean(rawIsActive);

  // Check language and name if provided
  const languageCode = typeof rawLanguageCode === "string" ? rawLanguageCode.trim() : "en";
  let name: string | null = null;
  let description: string | null = null;

  if (rawName !== undefined && rawName !== null && String(rawName).trim().length > 0) {
    const nameRes = validateName(rawName, languageCode.toUpperCase());
    if (!nameRes.success) {
      errors.name = nameRes.error;
    } else {
      name = nameRes.data;
    }
  }

  const descRes = validateDescription(rawDescription, languageCode.toUpperCase());
  if (!descRes.success) {
    errors.description = descRes.error;
  } else {
    description = descRes.data;
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
    const targetLanguage = languages.find((l) => l.code === languageCode);

    await updateCatalogCategory(db, categoryId, {
      slug,
      isActive,
    });

    if (name && targetLanguage) {
      await saveCatalogCategoryTranslation(db, {
        categoryId,
        languageId: targetLanguage.id,
        name,
        description,
      });
    }

    revalidatePath("/catalog");
    return {
      success: true,
      categoryId,
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

  // Optional Arabic
  let arabicName: string | null = null;
  if (rawArabicName !== undefined && rawArabicName !== null && String(rawArabicName).trim().length > 0) {
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
    if (!defaultLangId) {
      return {
        success: false,
        code: "SETTINGS_NOT_INITIALIZED",
        message: "Store default language is not configured. Please complete store setup in Settings.",
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

    if (arabicName) {
      const arabicLang = languages.find((l) => l.code === "ar");
      if (arabicLang) {
        translationsToInsert.push({
          languageId: arabicLang.id,
          name: arabicName,
          description: arabicDesc,
          details: arabicDetails,
        });
      }
    }

    const result = await createCatalogProduct(db, {
      categoryId,
      slug,
      price,
      translations: translationsToInsert,
    });

    revalidatePath("/catalog");
    return {
      success: true,
      productId: result.productId,
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
 */
export async function updateProductAction(
  input: UpdateProductActionInput,
): Promise<CatalogActionResult> {
  await requireAdmin();

  const rawProductId = extractField(input, "productId");
  const rawSlug = extractField(input, "slug");
  const rawPrice = extractField(input, "price");
  const rawIsActive = extractField(input, "isActive");
  const rawLanguageCode = extractField(input, "languageCode");
  const rawName = extractField(input, "name");
  const rawDescription = extractField(input, "description");
  const rawDetails = extractField(input, "details");

  const errors: Record<string, string> = {};

  const idRes = validateUuid(rawProductId, "Product ID");
  let productId = "";
  if (!idRes.success) {
    errors.productId = idRes.error;
  } else {
    productId = idRes.data;
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

  const isActive = validateBoolean(rawIsActive);

  const languageCode = typeof rawLanguageCode === "string" ? rawLanguageCode.trim() : "en";
  let name: string | null = null;
  let description: string | null = null;
  let details: string | null = null;

  if (rawName !== undefined && rawName !== null && String(rawName).trim().length > 0) {
    const nameRes = validateName(rawName, languageCode.toUpperCase());
    if (!nameRes.success) {
      errors.name = nameRes.error;
    } else {
      name = nameRes.data;
    }
  }

  const descRes = validateDescription(rawDescription, languageCode.toUpperCase());
  if (!descRes.success) {
    errors.description = descRes.error;
  } else {
    description = descRes.data;
  }

  const detailsRes = validateDetails(rawDetails, languageCode.toUpperCase());
  if (!detailsRes.success) {
    errors.details = detailsRes.error;
  } else {
    details = detailsRes.data;
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
    const targetLanguage = languages.find((l) => l.code === languageCode);

    await updateCatalogProduct(db, productId, {
      slug,
      price,
      isActive,
    });

    if (name && targetLanguage) {
      await saveCatalogProductTranslation(db, {
        productId,
        languageId: targetLanguage.id,
        name,
        description,
        details,
      });
    }

    revalidatePath("/catalog");
    return {
      success: true,
      productId,
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
