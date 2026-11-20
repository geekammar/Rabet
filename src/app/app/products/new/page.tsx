import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import { MerchantProductCreate } from "@/components/merchant/merchant-product-create";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import { listCatalogCategoriesForStore } from "@/lib/data/catalog";
import { resolveMerchantCatalogLanguage } from "@/lib/merchant/product-create";

export const metadata: Metadata = {
  title: "إضافة منتج",
  description: "Add the first draft product to the signed-in merchant store.",
  robots: { index: false, follow: false },
};

export const instant = false;

export default async function MerchantProductCreatePage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const access = await requireMerchantAccess();
  const db = getDb();
  const [categories, language] = await Promise.all([
    access.readOnly
      ? Promise.resolve([])
      : listCatalogCategoriesForStore(db, access.scope),
    resolveMerchantCatalogLanguage(db),
  ]);

  const options = categories.map((category) => ({
    id: category.id,
    name:
      (language
        ? category.translations[language.code]?.name
        : undefined) ??
      category.translations.ar?.name ??
      category.translations.en?.name ??
      category.slug,
  }));

  return (
    <MerchantProductCreate
      storeName={access.store.name}
      storeId={access.store.id}
      userId={access.userId}
      readOnly={access.readOnly}
      languageUnavailable={language === null}
      categories={options}
    />
  );
}
