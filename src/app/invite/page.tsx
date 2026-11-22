import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { InvitationAcceptance } from "@/components/merchant/invitation-acceptance";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import {
  INVITATION_BRAND,
  INVITATION_PAGE_TITLE,
} from "@/lib/merchant-invitation/branding";

export const metadata: Metadata = {
  title: INVITATION_PAGE_TITLE.ar,
  description: `Accept a ${INVITATION_BRAND.en} merchant invitation.`,
  robots: { index: false, follow: false },
};

export const instant = false;

export default async function InvitePage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  return <InvitationAcceptance />;
}
