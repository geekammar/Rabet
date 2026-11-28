import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";

import { MerchantLoginForm } from "@/components/merchant/merchant-login-form";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";
import {
  readMerchantLocale,
  merchantPageMetadata,
} from "@/lib/merchant/locale-server";
import {
  merchantPostLoginPath,
  parseMerchantOrderId,
} from "@/lib/merchant/order-link";

export async function generateMetadata(): Promise<Metadata> {
  return merchantPageMetadata(
    "login",
    "Sign in to your Rabet merchant store.",
  );
}

export const instant = false;

export default async function MerchantLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string | string[] }>;
}) {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const orderId = parseMerchantOrderId((await searchParams).order);
  const access = await getMerchantAccess();

  if (access) redirect(merchantPostLoginPath(orderId));

  const initialLocale = await readMerchantLocale();

  return <MerchantLoginForm initialLocale={initialLocale} orderId={orderId} />;
}
