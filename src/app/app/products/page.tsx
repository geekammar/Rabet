import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import { MerchantProducts } from "@/components/merchant/merchant-products";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import { listCatalogProductsForStore } from "@/lib/data/catalog";
import {
  readMerchantLocale,
  merchantPageMetadata,
} from "@/lib/merchant/locale-server";
import { resolveMerchantProductName } from "@/lib/merchant/product-display";

export async function generateMetadata(): Promise<Metadata> {
  return merchantPageMetadata(
    "products",
    "Review and price the signed-in merchant store products.",
  );
}

export const instant = false;

export default async function MerchantProductsPage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const access = await requireMerchantAccess();
  const [products, initialLocale] = await Promise.all([
    listCatalogProductsForStore(getDb(), access.scope),
    readMerchantLocale(),
  ]);

  return (
    <MerchantProducts
      storeName={access.store.name}
      readOnly={access.readOnly}
      initialLocale={initialLocale}
      products={products.map((product) => ({
        id: product.id,
        name: resolveMerchantProductName(product.translations, product.slug),
        price: product.price,
        revision: product.revision,
        isActive: product.isActive,
        categoryPathVisible: product.categoryPathVisible,
      }))}
    />
  );
}
