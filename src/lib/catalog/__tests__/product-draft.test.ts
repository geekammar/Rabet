import { describe, expect, it } from "vitest";

import {
  createProductEditDraft,
  ensureProductEditDraft,
} from "@/lib/catalog/product-draft";
import type { CatalogProductRecord } from "@/lib/data/catalog";

const now = new Date("2026-01-01T00:00:00.000Z");

function savedProduct(overrides?: Partial<CatalogProductRecord>): CatalogProductRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    categoryId: "22222222-2222-4222-8222-222222222222",
    slug: "saved-product",
    price: "49.50",
    isActive: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    translations: {
      en: {
        id: "trans-en",
        languageId: "lang-en",
        name: "Saved Product",
        description: "Saved description",
        details: "Saved details",
      },
      ar: {
        id: "trans-ar",
        languageId: "lang-ar",
        name: "منتج محفوظ",
        description: "وصف محفوظ",
        details: "تفاصيل محفوظة",
      },
    },
    ...overrides,
  };
}

describe("QA-24 product editor draft", () => {
  it("initialises every saved field and the active state from the product", () => {
    const draft = createProductEditDraft(savedProduct());

    expect(draft.productId).toBe("11111111-1111-4111-8111-111111111111");
    expect(draft.categoryId).toBe("22222222-2222-4222-8222-222222222222");
    expect(draft.slug).toBe("saved-product");
    expect(draft.price).toBe("49.50");
    expect(draft.isActive).toBe(true);
    expect(draft.translations.en).toEqual({
      name: "Saved Product",
      description: "Saved description",
      details: "Saved details",
    });
    expect(draft.translations.ar?.name).toBe("منتج محفوظ");
  });

  it("preserves an existing draft for the same product across editor navigation", () => {
    const product = savedProduct();
    const initial = createProductEditDraft(product);
    const unsaved = {
      ...initial,
      price: "55.00",
      translations: {
        ...initial.translations,
        en: { ...initial.translations.en, description: "Unsaved edit" },
      },
    };

    expect(ensureProductEditDraft(unsaved, product)).toBe(unsaved);
    expect(ensureProductEditDraft(unsaved, product).isActive).toBe(true);
    expect(ensureProductEditDraft(unsaved, product).price).toBe("55.00");
  });

  it("never applies a draft from a different product to the newly selected product", () => {
    const first = savedProduct();
    const second = savedProduct({
      id: "33333333-3333-4333-8333-333333333333",
      slug: "second-product",
      price: "12.00",
      isActive: false,
    });

    const firstDraft = createProductEditDraft(first);
    const next = ensureProductEditDraft(firstDraft, second);

    expect(next).not.toBe(firstDraft);
    expect(next.productId).toBe(second.id);
    expect(next.slug).toBe("second-product");
    expect(next.price).toBe("12.00");
    expect(next.isActive).toBe(false);
  });
});
