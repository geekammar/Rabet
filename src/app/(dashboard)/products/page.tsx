import type { Metadata } from "next";
import { connection } from "next/server";

import { CatalogStoreSetupRequired } from "@/components/dashboard/catalog/catalog-store-setup-required";
import { ProductsAdmin } from "@/components/dashboard/catalog/products-admin";
import { DatabaseSetupRequired } from "@/components/dashboard/settings/database-setup-required";
import { DatabaseUnavailable } from "@/components/dashboard/settings/database-unavailable";
import { requireAdmin } from "@/lib/auth/session";
import { loadCatalogAdminViewData } from "@/lib/catalog/load-admin-data";

export const metadata: Metadata = {
  title: "Products",
  description: "Add and edit products directly, with direct category assignment.",
};

export const instant = false;

export default async function ProductsPage() {
  await connection();
  await requireAdmin();

  const result = await loadCatalogAdminViewData();

  switch (result.kind) {
    case "database_setup_required":
      return (
        <DatabaseSetupRequired
          title="Products"
          description="Add and edit products directly, with direct category assignment."
        />
      );
    case "database_unavailable":
      return (
        <DatabaseUnavailable
          title="Products"
          description="Add and edit products directly, with direct category assignment."
          message={result.message}
        />
      );
    case "store_setup_required":
      return <CatalogStoreSetupRequired />;
    case "ready":
      return (
        <ProductsAdmin
          settings={result.data.settings}
          defaultLanguage={result.data.defaultLanguage}
          languages={result.data.languages}
          categories={result.data.categories}
          products={result.data.products}
        />
      );
  }
}
