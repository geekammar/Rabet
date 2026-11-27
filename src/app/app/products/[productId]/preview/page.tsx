import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import { MerchantProductPreview } from "@/components/merchant/merchant-product-preview";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import {
  merchantPageMetadata,
  readMerchantLocale,
} from "@/lib/merchant/locale-server";
import { readMerchantProductPreview } from "@/lib/merchant/product-publish";

export async function generateMetadata(): Promise<Metadata> {
  return merchantPageMetadata(
    "products",
    "Private buyer-view preview of a merchant product.",
  );
}

export const instant = false;

export default async function MerchantProductPreviewPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const access = await requireMerchantAccess();
  const { productId } = await params;
  const [preview, initialLocale] = await Promise.all([
    readMerchantProductPreview(getDb(), access, productId),
    readMerchantLocale(),
  ]);

  if (!preview) notFound();

  return (
    <MerchantProductPreview
      storeName={access.store.name}
      readOnly={access.readOnly}
      initialLocale={initialLocale}
      product={{
        id: preview.product.id,
        name: preview.product.name,
        description: preview.product.description,
        details: preview.product.details,
        price: preview.product.price,
        currency: preview.currency,
        imageUrl: preview.product.imageUrl,
        availability: preview.product.availability,
      }}
      isActive={preview.isActive}
      revision={preview.revision}
      readiness={
        preview.readiness
          ? {
              ready: preview.readiness.ready,
              reasons: preview.readiness.reasons,
            }
          : null
      }
    />
  );
}
