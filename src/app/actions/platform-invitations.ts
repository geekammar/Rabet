"use server";

import { revalidatePath } from "next/cache";

import { requirePlatformAdmin } from "@/lib/auth/platform-session";
import {
  MERCHANT_INVITATION_REJECTION_MESSAGE,
  MerchantInvitationError,
  issueMerchantInvitation,
  revokeMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import { getTransactionDb } from "@/db/transaction-client";

/**
 * Platform invitation management Server Actions.
 *
 * Every action calls the authoritative `requirePlatformAdmin()` gate before it
 * reads form input or touches the invitation service. The service then
 * independently re-checks that the actor is an active database Super Admin
 * inside its transaction. A merchant session cannot pass either check.
 *
 * The raw invitation token is returned only in the successful issue response
 * and is never written to a log. The link carries the token in the URL
 * fragment, so the browser does not send it to the server on navigation or
 * through the `Referer` header.
 */

const GENERIC_ISSUE_FAILURE = "The invitation could not be issued. Try again.";
const GENERIC_REVOKE_FAILURE = "The invitation could not be revoked. Try again.";

export type IssuedPlatformInvitation = {
  id: string;
  invitedEmail: string;
  storeName: string;
  storeSlug: string;
  expiresAt: string;
  invitePath: string;
};

export type PlatformIssueState = {
  status?: "success" | "error";
  message?: string;
  issued?: IssuedPlatformInvitation;
};

export type PlatformRevokeState = {
  status?: "success" | "error";
  message?: string;
};

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function issueErrorMessage(error: MerchantInvitationError): string {
  switch (error.code) {
    case "CONFLICT":
      return "That store slug is already in use. Choose another slug.";
    case "INVALID_INPUT":
      return "Check the recipient email, store name and store slug.";
    case "FORBIDDEN":
      return "This account cannot issue invitations.";
    default:
      return GENERIC_ISSUE_FAILURE;
  }
}

function revokeErrorMessage(error: MerchantInvitationError): string {
  switch (error.code) {
    case "INVITATION_REJECTED":
      return MERCHANT_INVITATION_REJECTION_MESSAGE;
    case "INVALID_INPUT":
      return "A valid invitation is required.";
    case "FORBIDDEN":
      return "This account cannot revoke invitations.";
    default:
      return GENERIC_REVOKE_FAILURE;
  }
}

export async function issuePlatformInvitation(
  _previous: PlatformIssueState | undefined,
  formData: FormData,
): Promise<PlatformIssueState> {
  const admin = await requirePlatformAdmin();

  const storeSlug = readString(formData, "storeSlug").trim();

  try {
    const issued = await issueMerchantInvitation(getTransactionDb(), {
      actorUserId: admin.id,
      storeName: readString(formData, "storeName"),
      storeSlug: storeSlug === "" ? undefined : storeSlug,
      invitedEmail: readString(formData, "invitedEmail"),
    });

    revalidatePath("/platform/invitations");

    return {
      status: "success",
      message: "Invitation issued. Copy the link now; it is not shown again.",
      issued: {
        id: issued.invitationId,
        invitedEmail: issued.invitedEmail,
        storeName: issued.storeName,
        storeSlug: issued.storeSlug,
        expiresAt: issued.expiresAt.toISOString(),
        invitePath: `/invite#token=${encodeURIComponent(issued.token)}`,
      },
    };
  } catch (error) {
    if (error instanceof MerchantInvitationError) {
      return { status: "error", message: issueErrorMessage(error) };
    }

    return { status: "error", message: GENERIC_ISSUE_FAILURE };
  }
}

export async function revokePlatformInvitation(
  _previous: PlatformRevokeState | undefined,
  formData: FormData,
): Promise<PlatformRevokeState> {
  const admin = await requirePlatformAdmin();

  try {
    await revokeMerchantInvitation(getTransactionDb(), {
      actorUserId: admin.id,
      invitationId: readString(formData, "invitationId"),
    });

    revalidatePath("/platform/invitations");

    return { status: "success", message: "Invitation revoked." };
  } catch (error) {
    if (error instanceof MerchantInvitationError) {
      return { status: "error", message: revokeErrorMessage(error) };
    }

    return { status: "error", message: GENERIC_REVOKE_FAILURE };
  }
}
