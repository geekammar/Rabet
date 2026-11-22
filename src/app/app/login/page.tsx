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

export async function generateMetadata(): Promise<Metadata> {
  return merchantPageMetadata(
    "login",
    "Sign in to your Rabet merchant store.",
  );
}

export const instant = false;

export default async function MerchantLoginPage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const access = await getMerchantAccess();

  if (access) redirect("/app/setup");

  const initialLocale = await readMerchantLocale();

  return <MerchantLoginForm initialLocale={initialLocale} />;
}
