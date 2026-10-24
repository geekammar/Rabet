import type { Metadata } from "next";
import { connection } from "next/server";

import { CatalogEditor } from "@/components/dashboard/catalog/catalog-editor";
import { CatalogStoreSetupRequired } from "@/components/dashboard/catalog/catalog-store-setup-required";
import { DatabaseSetupRequired } from "@/components/dashboard/settings/database-setup-required";
import { DatabaseUnavailable } from "@/components/dashboard/settings/database-unavailable";
import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  isConfigured,
  listCatalogCategories,
  listCatalogProducts,
  listLanguages,
  readSettings,
  resolveDefaultLanguage,
  toSafeErrorMessage,
} from "@/lib/data";

export const metadata: Metadata = {
  title: "Catalog",
  description: "Digital products, categories, displayed prices and customer navigation.",
};

export const instant = false;

type CatalogViewResult =
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

async function loadCatalogViewData(): Promise<CatalogViewResult> {
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

export default async function CatalogPage() {
  await connection();

  // Authoritative boundary check (ADR-010)
  await requireAdmin();

  const result = await loadCatalogViewData();

  switch (result.kind) {
    case "database_setup_required":
      return (
        <DatabaseSetupRequired
          title="Catalog"
          description="Digital products, categories, displayed prices and customer navigation."
        />
      );
    case "database_unavailable":
      return (
        <DatabaseUnavailable
          title="Catalog"
          description="Digital products, categories, displayed prices and customer navigation."
          message={result.message}
        />
      );
    case "store_setup_required":
      return <CatalogStoreSetupRequired />;
    case "ready":
      return (
        <CatalogEditor
          settings={result.data.settings}
          defaultLanguage={result.data.defaultLanguage}
          languages={result.data.languages}
          categories={result.data.categories}
          products={result.data.products}
        />
      );
  }
}
