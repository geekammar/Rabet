import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth-platform";
import { getTransactionDb } from "@/db/transaction-client";
import {
  resolvePlatformAdminAccess,
  type PlatformAdminAccess,
  type PlatformSessionLike,
} from "@/lib/auth/platform-access";

/**
 * The authoritative server-side gate for the platform administration surface.
 *
 * The platform JWT carries only the `app_user` id, role and the
 * `session_version` observed at sign-in. On every protected request
 * `resolvePlatformAdminAccess()` re-reads the identity and requires an
 * authenticated `platform_admin` session whose `app_user` row is still
 * `active`, has `platform_role = 'super_admin'`, and carries the same session
 * version (so a password reset can revoke old sessions).
 *
 * A merchant session uses a different Auth.js instance and cookie namespace,
 * so it is not even readable here; a forged role claim still fails the
 * database checks. Zero other roles are accepted.
 *
 * `cache()` deduplicates the auth read and database round-trip within one
 * request render. It does not survive the request.
 */

export type { PlatformAdminAccess } from "@/lib/auth/platform-access";

/**
 * Returns verified platform access, or `null` when there is none.
 */
export const getPlatformAdminAccess = cache(
  async (): Promise<PlatformAdminAccess | null> => {
    const session = (await auth()) as PlatformSessionLike;

    try {
      return await resolvePlatformAdminAccess(getTransactionDb(), session);
    } catch {
      console.error(
        "Platform administrator access resolution failed; denying access.",
      );
      return null;
    }
  },
);

/**
 * Asserts verified platform access. Redirects to `/platform/login` when the
 * session is absent or no longer valid. The destination is fixed and internal.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminAccess> {
  const access = await getPlatformAdminAccess();

  if (!access) {
    redirect("/platform/login");
  }

  return access;
}
