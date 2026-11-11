import type {
  CatalogCategoryRecord,
  CatalogProductRecord,
} from "@/lib/data/catalog";
import type { LanguageRow, PaymentMethodRecord, ResolvedLanguage } from "@/lib/data";
import type { HierarchyCategoryNode } from "@/lib/catalog/tree";

export type {
  CatalogCategoryRecord,
  CatalogProductRecord,
  HierarchyCategoryNode,
  PaymentMethodRecord,
};

export interface CatalogViewData {
  settings: {
    displayName: string;
    currency: string;
    supportCategory?: string[];
  };
  defaultLanguage: ResolvedLanguage | null;
  languages: LanguageRow[];
  categories: CatalogCategoryRecord[];
  products: CatalogProductRecord[];
  paymentMethods?: PaymentMethodRecord[];
  paymentMethodsAvailable?: boolean;
}
