import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { InvitationAcceptance } from "@/components/merchant/invitation-acceptance";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";

export const metadata: Metadata = {
  title: "قبول الدعوة",
  description: "Accept a Rabet merchant invitation.",
  robots: { index: false, follow: false },
};

export const instant = false;

export default async function InvitePage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  return <InvitationAcceptance />;
}
