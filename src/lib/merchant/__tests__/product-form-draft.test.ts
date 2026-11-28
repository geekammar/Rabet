import { describe, expect, it } from "vitest";

import {
  PRODUCT_FORM_DRAFT_TTL_MS,
  clearProductFormDraft,
  lastCategoryKey,
  productFormDraftKey,
  readLastCategory,
  readProductFormDraft,
  restoreProductFormDraft,
  writeLastCategory,
  writeProductFormDraft,
  type DraftStorage,
  type ProductFormDraft,
} from "@/lib/merchant/product-form-draft";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const CATEGORY_ID = "33333333-3333-4333-8333-333333333333";

class MemoryStorage implements DraftStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function draft(overrides?: Partial<ProductFormDraft>): ProductFormDraft {
  return {
    name: "منتج النور",
    price: "19.90",
    categoryId: "",
    newCategoryName: "العناية",
    useNewCategory: true,
    description: "وصف المنتج",
    imageUrl: "https://example.test/product.jpg",
    stock: "12",
    ...overrides,
  };
}

describe("merchant product form draft", () => {
  it("scopes keys to the user and store", () => {
    expect(productFormDraftKey(STORE_ID, USER_ID)).toBe(
      `rabet:draft:${STORE_ID}:${USER_ID}:merchant-product-create`,
    );
    expect(lastCategoryKey(STORE_ID, USER_ID)).toBe(
      `rabet:last-category:${STORE_ID}:${USER_ID}`,
    );
  });

  it("round-trips plain form values for seven days", () => {
    const storage = new MemoryStorage();
    const key = productFormDraftKey(STORE_ID, USER_ID);
    const now = 1_800_000_000_000;

    writeProductFormDraft(storage, key, draft(), now);

    expect(readProductFormDraft(storage, key, now + 1000)).toEqual(draft());
    expect(
      readProductFormDraft(storage, key, now + PRODUCT_FORM_DRAFT_TTL_MS),
    ).toEqual(draft());
  });

  it("restores an older draft that predates the description, image and stock fields", () => {
    const storage = new MemoryStorage();
    const key = productFormDraftKey(STORE_ID, USER_ID);
    const now = 1_800_000_000_000;

    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        savedAt: now,
        name: "منتج قديم",
        price: "5.00",
        categoryId: "",
        newCategoryName: "",
        useNewCategory: true,
      }),
    );

    expect(readProductFormDraft(storage, key, now)).toEqual({
      name: "منتج قديم",
      price: "5.00",
      categoryId: "",
      newCategoryName: "",
      useNewCategory: true,
      description: "",
      imageUrl: "",
      stock: "",
    });
  });

  it("ignores expired, future-dated and malformed drafts", () => {
    const storage = new MemoryStorage();
    const key = productFormDraftKey(STORE_ID, USER_ID);
    const now = 1_800_000_000_000;

    writeProductFormDraft(storage, key, draft(), now);
    expect(
      readProductFormDraft(storage, key, now + PRODUCT_FORM_DRAFT_TTL_MS + 1),
    ).toBeNull();

    writeProductFormDraft(storage, key, draft(), now + 60_000);
    expect(readProductFormDraft(storage, key, now)).toBeNull();

    storage.setItem(key, "{not-json");
    expect(readProductFormDraft(storage, key, now)).toBeNull();

    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        savedAt: now,
        name: 42,
        price: "1.00",
        categoryId: "",
        newCategoryName: "",
        useNewCategory: true,
      }),
    );
    expect(readProductFormDraft(storage, key, now)).toBeNull();
  });

  it("clears the draft and remembers only a valid category id", () => {
    const storage = new MemoryStorage();
    const key = productFormDraftKey(STORE_ID, USER_ID);
    const categoryKey = lastCategoryKey(STORE_ID, USER_ID);

    writeProductFormDraft(storage, key, draft());
    writeLastCategory(storage, categoryKey, CATEGORY_ID);
    expect(readLastCategory(storage, categoryKey)).toBe(CATEGORY_ID);

    writeLastCategory(storage, categoryKey, "not-a-uuid");
    expect(readLastCategory(storage, categoryKey)).toBe(CATEGORY_ID);

    clearProductFormDraft(storage, key);
    expect(readProductFormDraft(storage, key)).toBeNull();
  });
});

describe("merchant product draft restoration", () => {
  const CATEGORY_IDS = [{ id: CATEGORY_ID }];

  it("applies once and does not overwrite after a replay", () => {
    const input = {
      draft: draft({ useNewCategory: false, categoryId: CATEGORY_ID }),
      lastCategoryId: null,
      categories: CATEGORY_IDS,
      alreadyRestored: false,
      edited: false,
    };

    expect(restoreProductFormDraft(input)).toMatchObject({
      name: "منتج النور",
      categoryId: CATEGORY_ID,
      useNewCategory: false,
    });
    expect(
      restoreProductFormDraft({ ...input, alreadyRestored: true }),
    ).toBeNull();
    expect(restoreProductFormDraft({ ...input, edited: true })).toBeNull();
  });

  it("allows a cancelled deferred restore to run on replay", () => {
    const input = {
      draft: draft(),
      lastCategoryId: null,
      categories: CATEGORY_IDS,
      alreadyRestored: false,
      edited: false,
    };

    expect(
      restoreProductFormDraft({ ...input, cancelled: true }),
    ).toBeNull();
    expect(restoreProductFormDraft(input)).toMatchObject({
      name: "منتج النور",
      useNewCategory: true,
    });
  });

  it("falls back to a valid last or first category without an empty draft", () => {
    expect(
      restoreProductFormDraft({
        draft: null,
        lastCategoryId: CATEGORY_ID,
        categories: CATEGORY_IDS,
        alreadyRestored: false,
        edited: false,
      }),
    ).toMatchObject({ categoryId: CATEGORY_ID, useNewCategory: false });

    expect(
      restoreProductFormDraft({
        draft: null,
        lastCategoryId: "44444444-4444-4444-8444-444444444444",
        categories: CATEGORY_IDS,
        alreadyRestored: false,
        edited: false,
      }),
    ).toMatchObject({ categoryId: CATEGORY_ID, useNewCategory: false });
  });

  it("does not keep a stale draft category that left the current list", () => {
    expect(
      restoreProductFormDraft({
        draft: draft({
          useNewCategory: false,
          categoryId: "44444444-4444-4444-8444-444444444444",
        }),
        lastCategoryId: null,
        categories: [],
        alreadyRestored: false,
        edited: false,
      }),
    ).toMatchObject({ categoryId: "", useNewCategory: true });
  });
});
