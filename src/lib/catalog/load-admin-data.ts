import "server-only";

import { getDb } from "@/db/client";
import {
  isConfigured,
  listCatalogCategories,
  listCatalogProducts,
  listLanguages,
  readSettings,
  resolveDefaultLanguage,
  toSafeErrorMessage,
} from "@/lib/data";

export type CatalogAdminViewResult =
  | { kind: "database_setup_required" }
  | { kind: "database_unavailable"; message: string }
  | { kind: "store_setup_required" }
  | {
      kind: "ready";
      data: {
        settings: {
          displayName: string;
          currency: string;
        };
        defaultLanguage: Awaited<ReturnType<typeof resolveDefaultLanguage>>;
        languages: Awaited<ReturnType<typeof listLanguages>>;
        categories: Awaited<ReturnType<typeof listCatalogCategories>>;
        products: Awaited<ReturnType<typeof listCatalogProducts>>;
      };
    };

export async function loadCatalogAdminViewData(): Promise<CatalogAdminViewResult> {
  const rawDbUrl = process.env.DATABASE_URL;
  if (!rawDbUrl || rawDbUrl.trim().length === 0) {
    return { kind: "database_setup_required" };
  }

  try {
    const db = getDb();
    const configured = await isConfigured(db);

    if (!configured) {
      return { kind: "store_setup_required" };
    }

    const settings = await readSettings(db);
    if (!settings) {
      return { kind: "store_setup_required" };
    }

    const [languages, defaultLanguage, categories, products] = await Promise.all([
      listLanguages(db),
      resolveDefaultLanguage(db),
      listCatalogCategories(db),
      listCatalogProducts(db),
    ]);

    return {
      kind: "ready",
      data: {
        settings: {
          displayName: settings.displayName,
          currency: settings.currency,
        },
        defaultLanguage,
        languages,
        categories,
        products,
      },
    };
  } catch (error) {
    return {
      kind: "database_unavailable",
      message: toSafeErrorMessage(error),
    };
  }
}
