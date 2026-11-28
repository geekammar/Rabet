"use server";

import { getTransactionDb } from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";
import { saveStorefrontProfile } from "@/lib/merchant/storefront-profile";
import { parseStorefrontProfile, type StorefrontProfile } from "@/lib/merchant/storefront-profile-fields";

export type StorefrontProfileSaveState =
  | { status: "idle" | "saved" | "denied" | "unavailable" }
  | { status: "invalid"; field: keyof StorefrontProfile };

export async function saveMerchantStorefrontProfile(
  _previous: StorefrontProfileSaveState,
  input: FormData,
): Promise<StorefrontProfileSaveState> {
  if (!isMerchantAppEnabled()) return { status: "unavailable" };
  const access = await getMerchantAccess();
  if (!access || access.readOnly) return { status: "denied" };

  const parsed = parseStorefrontProfile(input);
  if (!parsed.ok) return { status: "invalid", field: parsed.field };

  try {
    return { status: await saveStorefrontProfile(getTransactionDb(), access, parsed.profile)
      ? "saved" : "denied" };
  } catch {
    console.error("Merchant storefront profile update failed.");
    return { status: "unavailable" };
  }
}
