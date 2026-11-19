import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";

import { MerchantLoginForm } from "@/components/merchant/merchant-login-form";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";

export const metadata: Metadata = {
  title: "تسجيل دخول التاجر",
  description: "Sign in to your Rabet merchant store.",
  robots: { index: false, follow: false },
};

export const instant = false;

export default async function MerchantLoginPage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const access = await getMerchantAccess();

  if (access) redirect("/app/setup");

  return <MerchantLoginForm />;
}
