import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import { MerchantCategories } from "@/components/merchant/merchant-categories";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import { listCatalogCategoriesForStore } from "@/lib/data/catalog";
import { resolveMerchantCategoryName } from "@/lib/merchant/category-display";

export const metadata: Metadata = {
  title: "أقسام المتجر",
  description: "Review and control the signed-in merchant store categories.",
  robots: { index: false, follow: false },
};

export const instant = false;

export default async function MerchantCategoriesPage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const access = await requireMerchantAccess();
  const categories = await listCatalogCategoriesForStore(
    getDb(),
    access.scope,
  );

  return (
    <MerchantCategories
      storeName={access.store.name}
      readOnly={access.readOnly}
      categories={categories.map((category) => ({
        id: category.id,
        name: resolveMerchantCategoryName(
          category.translations,
          category.slug,
        ),
        revision: category.revision,
        isActive: category.isActive,
        pathVisible: category.pathVisible,
        parentId: category.parentId,
        parentResolved: category.parentResolved,
      }))}
    />
  );
}
