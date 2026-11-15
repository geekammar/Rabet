import type { Metadata } from "next";
import { connection } from "next/server";

import { CategoriesAdmin } from "@/components/dashboard/catalog/categories-admin";
import { CatalogStoreSetupRequired } from "@/components/dashboard/catalog/catalog-store-setup-required";
import { DatabaseSetupRequired } from "@/components/dashboard/settings/database-setup-required";
import { DatabaseUnavailable } from "@/components/dashboard/settings/database-unavailable";
import { requireAdmin } from "@/lib/auth/session";
import { loadCatalogAdminViewData } from "@/lib/catalog/load-admin-data";

export const metadata: Metadata = {
  title: "Categories",
  description: "Create and edit root or child categories.",
};

export const instant = false;

export default async function CategoriesPage() {
  await connection();
  await requireAdmin();

  const result = await loadCatalogAdminViewData();

  switch (result.kind) {
    case "database_setup_required":
      return (
        <DatabaseSetupRequired
          title="Categories"
          description="Create and edit root or child categories."
        />
      );
    case "database_unavailable":
      return (
        <DatabaseUnavailable
          title="Categories"
          description="Create and edit root or child categories."
          message={result.message}
        />
      );
    case "store_setup_required":
      return <CatalogStoreSetupRequired />;
    case "ready":
      return (
        <CategoriesAdmin
          defaultLanguage={result.data.defaultLanguage}
          languages={result.data.languages}
          categories={result.data.categories}
          products={result.data.products}
        />
      );
  }
}
