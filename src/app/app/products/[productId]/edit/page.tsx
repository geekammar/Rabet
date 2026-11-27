import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import { MerchantProductEdit } from "@/components/merchant/merchant-product-edit";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import {
  merchantPageMetadata,
  readMerchantLocale,
} from "@/lib/merchant/locale-server";
import { readMerchantCatalogProductForEdit } from "@/lib/merchant/product-edit";
import { resolveMerchantCatalogLanguage } from "@/lib/merchant/product-create";
import { resolveMerchantProductName } from "@/lib/merchant/product-display";

export async function generateMetadata(): Promise<Metadata> {
  return merchantPageMetadata(
    "products",
    "Edit a draft product in the signed-in merchant store.",
  );
}

export const instant = false;

export default async function MerchantProductEditPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const access = await requireMerchantAccess();
  const { productId } = await params;
  const db = getDb();
  const [product, language, initialLocale] = await Promise.all([
    readMerchantCatalogProductForEdit(db, access, productId),
    resolveMerchantCatalogLanguage(db),
    readMerchantLocale(),
  ]);

  if (!product) notFound();

  const languageUnavailable = language === null;
  const preferred =
    (language ? product.translations[language.code] : undefined) ??
    product.translations.en ??
    product.translations.ar ??
    Object.values(product.translations)[0];

  return (
    <MerchantProductEdit
      storeName={access.store.name}
      readOnly={access.readOnly}
      languageUnavailable={languageUnavailable}
      initialLocale={initialLocale}
      product={{
        id: product.id,
        name: resolveMerchantProductName(product.translations, product.slug),
        price: product.price,
        revision: product.revision,
        isActive: product.isActive,
        imageUrl: product.imageUrl ?? "",
        description: preferred?.description ?? "",
        onHand: product.inventory?.onHand ?? 0,
        reserved: product.inventory?.reserved ?? 0,
      }}
    />
  );
}
