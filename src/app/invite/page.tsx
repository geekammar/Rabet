import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { InvitationAcceptance } from "@/components/merchant/invitation-acceptance";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { readMerchantLocale, merchantPageMetadata } from "@/lib/merchant/locale-server";
import { INVITATION_BRAND } from "@/lib/merchant-invitation/branding";

export async function generateMetadata(): Promise<Metadata> {
  return merchantPageMetadata(
    "invite",
    `Accept a ${INVITATION_BRAND.en} merchant invitation.`,
  );
}

export const instant = false;

export default async function InvitePage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const initialLocale = await readMerchantLocale();

  return <InvitationAcceptance initialLocale={initialLocale} />;
}
