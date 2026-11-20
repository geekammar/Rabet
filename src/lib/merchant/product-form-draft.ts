export const PRODUCT_FORM_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PRODUCT_FORM_DRAFT_VERSION = 1;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProductFormDraft = {
  name: string;
  price: string;
  categoryId: string;
  newCategoryName: string;
  useNewCategory: boolean;
};

type StoredProductFormDraft = ProductFormDraft & {
  version: typeof PRODUCT_FORM_DRAFT_VERSION;
  savedAt: number;
};

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function productFormDraftKey(storeId: string, userId: string): string {
  return `rabet:draft:${storeId}:${userId}:merchant-product-create`;
}

export function lastCategoryKey(storeId: string, userId: string): string {
  return `rabet:last-category:${storeId}:${userId}`;
}

function isString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function readProductFormDraft(
  storage: DraftStorage,
  key: string,
  now = Date.now(),
): ProductFormDraft | null {
  try {
    const raw = storage.getItem(key);

    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;

    if (
      record.version !== PRODUCT_FORM_DRAFT_VERSION ||
      typeof record.savedAt !== "number" ||
      !Number.isFinite(record.savedAt)
    ) {
      return null;
    }

    const age = now - record.savedAt;

    if (age < 0 || age > PRODUCT_FORM_DRAFT_TTL_MS) return null;

    if (
      !isString(record.name, 255) ||
      !isString(record.price, 64) ||
      !isString(record.newCategoryName, 255) ||
      typeof record.useNewCategory !== "boolean" ||
      !(record.categoryId === "" || isUuid(record.categoryId))
    ) {
      return null;
    }

    return {
      name: record.name,
      price: record.price,
      categoryId: record.categoryId,
      newCategoryName: record.newCategoryName,
      useNewCategory: record.useNewCategory,
    };
  } catch {
    return null;
  }
}

export function writeProductFormDraft(
  storage: DraftStorage,
  key: string,
  draft: ProductFormDraft,
  now = Date.now(),
): void {
  try {
    const stored: StoredProductFormDraft = {
      ...draft,
      version: PRODUCT_FORM_DRAFT_VERSION,
      savedAt: now,
    };

    storage.setItem(key, JSON.stringify(stored));
  } catch {}
}

export function clearProductFormDraft(
  storage: DraftStorage,
  key: string,
): void {
  try {
    storage.removeItem(key);
  } catch {}
}

export function readLastCategory(
  storage: DraftStorage,
  key: string,
): string | null {
  try {
    const value = storage.getItem(key);

    return isUuid(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeLastCategory(
  storage: DraftStorage,
  key: string,
  categoryId: string,
): void {
  if (!isUuid(categoryId)) return;

  try {
    storage.setItem(key, categoryId);
  } catch {}
}
