import type { CatalogProductRecord } from "@/lib/data/catalog";

export interface ProductTranslationDraft {
  name: string;
  description: string;
  details: string;
}

export interface ProductEditDraft {
  productId: string;
  categoryId: string;
  slug: string;
  price: string;
  isActive: boolean;
  translations: Record<string, ProductTranslationDraft>;
}

export function createProductEditDraft(
  product: CatalogProductRecord,
): ProductEditDraft {
  const translations: Record<string, ProductTranslationDraft> = {};

  for (const [code, translation] of Object.entries(product.translations)) {
    translations[code] = {
      name: translation.name ?? "",
      description: translation.description ?? "",
      details: translation.details ?? "",
    };
  }

  return {
    productId: product.id,
    categoryId: product.categoryId,
    slug: product.slug,
    price: product.price,
    isActive: product.isActive,
    translations,
  };
}

export function ensureProductEditDraft(
  current: ProductEditDraft | null,
  product: CatalogProductRecord,
): ProductEditDraft {
  if (current?.productId === product.id) {
    return current;
  }

  return createProductEditDraft(product);
}
