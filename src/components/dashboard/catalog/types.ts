import type {
  CatalogCategoryRecord,
  CatalogProductRecord,
} from "@/lib/data/catalog";
import type { LanguageRow, ResolvedLanguage } from "@/lib/data";
import type { HierarchyCategoryNode } from "@/lib/catalog/tree";

export type {
  CatalogCategoryRecord,
  CatalogProductRecord,
  HierarchyCategoryNode,
};

export interface CatalogViewData {
  settings: {
    displayName: string;
    currency: string;
  };
  defaultLanguage: ResolvedLanguage | null;
  languages: LanguageRow[];
  categories: CatalogCategoryRecord[];
  products: CatalogProductRecord[];
}
