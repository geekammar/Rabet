import "server-only";

import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  category,
  categoryTranslation,
  language,
  product,
  productInventory,
  productTranslation,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import { generateCatalogSlug } from "@/lib/catalog/slug";
import {
  validateDescription,
  validateName,
  validatePrice,
  validateUuid,
  type ValidationResult,
} from "@/lib/catalog/validation";
import {
  merchantWriteEligibilityWhere,
  type MerchantPriceWriteIdentity,
} from "@/lib/data/catalog";

export type MerchantCatalogLanguage = {
  id: string;
  code: string;
  label: string;
  textDirection: "ltr" | "rtl";
};

export async function resolveMerchantCatalogLanguage(
  db: Database,
): Promise<MerchantCatalogLanguage | null> {
  const rows = await db
    .select({
      id: language.id,
      code: language.code,
      label: language.label,
      textDirection: language.textDirection,
      isEnabled: language.isEnabled,
    })
    .from(language)
    .orderBy(language.code);

  const enabled = rows.filter((row) => row.isEnabled);
  const selected =
    enabled.find((row) => row.code === "en") ??
    enabled.find((row) => row.code === "ar") ??
    enabled[0];

  if (!selected) return null;

  return {
    id: selected.id,
    code: selected.code,
    label: selected.label,
    textDirection: selected.textDirection === "rtl" ? "rtl" : "ltr",
  };
}

export const MAX_PRODUCT_IMAGE_URL_LENGTH = 2048;
export const MAX_PRODUCT_STOCK = 1_000_000;

export function validateProductImageUrl(
  raw: unknown,
): ValidationResult<string | null> {
  if (raw === undefined || raw === null) {
    return { success: true, data: null };
  }

  if (typeof raw !== "string") {
    return { success: false, error: "Image URL must be a string." };
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { success: true, data: null };
  }

  if (trimmed.length > MAX_PRODUCT_IMAGE_URL_LENGTH) {
    return {
      success: false,
      error: `Image URL must be ${MAX_PRODUCT_IMAGE_URL_LENGTH} characters or fewer.`,
    };
  }

  try {
    const parsed = new URL(trimmed);

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return {
        success: false,
        error: "Image URL must use the http or https scheme.",
      };
    }
  } catch {
    return { success: false, error: "Image URL must be a valid URL." };
  }

  return { success: true, data: trimmed };
}

export function validateProductStock(
  raw: unknown,
): ValidationResult<number | null> {
  if (raw === undefined || raw === null) {
    return { success: true, data: null };
  }

  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0 || raw > MAX_PRODUCT_STOCK) {
      return { success: false, error: "Stock must be a whole non-negative number." };
    }

    return { success: true, data: raw };
  }

  if (typeof raw !== "string") {
    return { success: false, error: "Stock must be a whole non-negative number." };
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { success: true, data: null };
  }

  if (!/^[0-9]{1,9}$/.test(trimmed)) {
    return { success: false, error: "Stock must be a whole non-negative number." };
  }

  const value = Number.parseInt(trimmed, 10);

  if (value > MAX_PRODUCT_STOCK) {
    return { success: false, error: `Stock must not exceed ${MAX_PRODUCT_STOCK}.` };
  }

  return { success: true, data: value };
}

export type MerchantProductCreateInput = {
  name: unknown;
  price: unknown;
  categoryId?: unknown;
  newCategoryName?: unknown;
  description?: unknown;
  imageUrl?: unknown;
  stock?: unknown;
};

export type MerchantProductCreateResult =
  | {
      ok: true;
      productId: string;
      categoryId: string;
      categoryCreated: boolean;
    }
  | {
      ok: false;
      error:
        | "INVALID_INPUT"
        | "DENIED"
        | "CATEGORY_NOT_FOUND"
        | "CONFLICT"
        | "LANGUAGE_UNAVAILABLE"
        | "UNAVAILABLE";
      fields?: {
        name?: boolean;
        price?: boolean;
        category?: boolean;
        newCategoryName?: boolean;
        description?: boolean;
        imageUrl?: boolean;
        stock?: boolean;
      };
    };

const MAX_WRITE_ATTEMPTS = 5;

class MerchantProductCreateRejection extends Error {
  readonly code: "DENIED" | "CATEGORY_NOT_FOUND";

  constructor(code: "DENIED" | "CATEGORY_NOT_FOUND") {
    super(code);
    this.name = "MerchantProductCreateRejection";
    this.code = code;
  }
}

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;

  for (
    let depth = 0;
    depth < 8 && current !== null && typeof current === "object";
    depth += 1
  ) {
    if ("code" in current) {
      const code = (current as { code?: unknown }).code;

      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }

    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }

  return undefined;
}

function resultRows<T>(result: unknown): T[] {
  const raw = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | null)?.rows;

  return Array.isArray(raw) ? (raw as T[]) : [];
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function createMerchantCatalogProduct(
  db: TransactionDatabase,
  access: MerchantAccess,
  language: MerchantCatalogLanguage,
  input: MerchantProductCreateInput,
): Promise<MerchantProductCreateResult> {
  if (access.readOnly) return { ok: false, error: "DENIED" };

  const name = validateName(input.name, "Product");
  const price = validatePrice(input.price);
  const description = validateDescription(input.description);
  const imageUrl = validateProductImageUrl(input.imageUrl);
  const stock = validateProductStock(input.stock);
  const rawCategoryId = trimmedString(input.categoryId);
  const rawNewCategoryName = trimmedString(input.newCategoryName);
  const useNewCategory =
    rawCategoryId.length === 0 || rawCategoryId === "new";

  const categoryId = useNewCategory
    ? null
    : validateUuid(rawCategoryId, "Category");
  const newCategoryName = useNewCategory
    ? validateName(rawNewCategoryName, "Category")
    : null;

  const fields: NonNullable<
    Extract<MerchantProductCreateResult, { ok: false }>["fields"]
  > = {};

  if (!name.success) fields.name = true;
  if (!price.success) fields.price = true;
  if (!description.success) fields.description = true;
  if (!imageUrl.success) fields.imageUrl = true;
  if (!stock.success) fields.stock = true;

  if (useNewCategory) {
    if (!newCategoryName || !newCategoryName.success) {
      fields.newCategoryName = true;
    }
  } else if (!categoryId || !categoryId.success) {
    fields.category = true;
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, error: "INVALID_INPUT", fields };
  }

  const validatedName = name.success ? name.data : "";
  const validatedPrice = price.success ? price.data : "";
  const validatedDescription = description.success ? description.data : null;
  const validatedImageUrl = imageUrl.success ? imageUrl.data : null;
  const validatedStock = stock.success ? stock.data : null;
  const validatedCategoryId =
    categoryId && categoryId.success ? categoryId.data : null;
  const validatedNewCategoryName =
    newCategoryName && newCategoryName.success ? newCategoryName.data : "";

  const identity: MerchantPriceWriteIdentity = {
    userId: access.userId,
    sessionVersion: access.sessionVersion,
  };

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        let resolvedCategoryId = validatedCategoryId;
        let categoryCreated = false;

        if (validatedNewCategoryName.length > 0) {
          const createdCategoryId = globalThis.crypto.randomUUID();
          const categorySlug = generateCatalogSlug(
            "category",
            validatedNewCategoryName,
          );
          const insertedCategory = await tx.execute<{ id: string }>(sql`
            insert into ${category} (
              id, store_id, parent_id, slug, sort_order, is_active
            )
            select
              ${createdCategoryId}::uuid,
              ${access.scope.storeId}::uuid,
              null,
              ${categorySlug},
              coalesce((
                select max(root.sort_order) + 1
                from ${category} as root
                where root.parent_id is null
              ), 0),
              false
            where ${merchantWriteEligibilityWhere(tx, access.scope, identity)}
            returning id
          `);

          const createdRows = resultRows<{ id: string }>(insertedCategory);
          const created = createdRows[0];

          if (!created) throw new MerchantProductCreateRejection("DENIED");

          resolvedCategoryId = created.id;
          categoryCreated = true;

          await tx.insert(categoryTranslation).values({
            id: globalThis.crypto.randomUUID(),
            categoryId: created.id,
            languageId: language.id,
            name: validatedNewCategoryName,
          });
        }

        if (!resolvedCategoryId) {
          throw new MerchantProductCreateRejection("CATEGORY_NOT_FOUND");
        }

        const productId = globalThis.crypto.randomUUID();
        const productSlug = generateCatalogSlug("product", validatedName);
        const insertedProduct = await tx.execute<{ id: string }>(sql`
          insert into ${product} (
            id, store_id, category_id, slug, price, image_url, is_active, sort_order
          )
          select
            ${productId}::uuid,
            ${access.scope.storeId}::uuid,
            owned_category.id,
            ${productSlug},
            ${validatedPrice}::numeric(18,2),
            ${validatedImageUrl}::text,
            false,
            coalesce((
              select max(sibling.sort_order) + 1
              from ${product} as sibling
              where sibling.category_id = owned_category.id
            ), 0)
          from ${category} as owned_category
          where owned_category.id = ${resolvedCategoryId}::uuid
            and owned_category.store_id = ${access.scope.storeId}::uuid
            and owned_category.deleted_at is null
            and ${merchantWriteEligibilityWhere(tx, access.scope, identity)}
          returning id
        `);

        const productRows = resultRows<{ id: string }>(insertedProduct);
        const createdProduct = productRows[0];

        if (!createdProduct) {
          throw new MerchantProductCreateRejection(
            categoryCreated ? "DENIED" : "CATEGORY_NOT_FOUND",
          );
        }

        await tx.insert(productTranslation).values({
          id: globalThis.crypto.randomUUID(),
          productId: createdProduct.id,
          languageId: language.id,
          name: validatedName,
          description: validatedDescription,
        });

        if (validatedStock !== null && validatedStock > 0) {
          await tx.insert(productInventory).values({
            productId: createdProduct.id,
            storeId: access.scope.storeId,
            onHand: validatedStock,
          });
        }

        return {
          ok: true as const,
          productId: createdProduct.id,
          categoryId: resolvedCategoryId,
          categoryCreated,
        };
      });
    } catch (error) {
      if (error instanceof MerchantProductCreateRejection) {
        return { ok: false, error: error.code };
      }

      if (sqlState(error) === "23505" && attempt < MAX_WRITE_ATTEMPTS) {
        continue;
      }

      if (sqlState(error) === "23505") {
        return { ok: false, error: "CONFLICT" };
      }

      console.error("Merchant product creation failed.");
      return { ok: false, error: "UNAVAILABLE" };
    }
  }

  return { ok: false, error: "CONFLICT" };
}

