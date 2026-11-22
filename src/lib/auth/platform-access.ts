import "server-only";

import { and, eq } from "drizzle-orm";

import { appUser } from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";

/**
 * Pure platform-access resolver.
 *
 * Kept separate from `platform-session.ts` so the authorization rule can be
 * exercised against PostgreSQL without importing the Auth.js runtime. The JWT
 * carries only the `app_user` id, role and the `session_version` observed at
 * sign-in; every fact is re-read here.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PlatformAdminAccess = {
  id: string;
  email: string;
  role: "platform_admin";
  sessionVersion: number;
};

export type PlatformSessionLike =
  | {
      user?: {
        id?: string;
        email?: string | null;
        role?: string;
        sessionVersion?: number;
      } | null;
    }
  | null;

export async function resolvePlatformAdminAccess(
  db: TransactionDatabase,
  session: PlatformSessionLike,
): Promise<PlatformAdminAccess | null> {
  const user = session?.user;

  if (
    !user ||
    user.role !== "platform_admin" ||
    typeof user.id !== "string" ||
    !UUID_PATTERN.test(user.id) ||
    typeof user.sessionVersion !== "number" ||
    !Number.isInteger(user.sessionVersion) ||
    user.sessionVersion < 0
  ) {
    return null;
  }

  const rows = await db
    .select({
      id: appUser.id,
      email: appUser.email,
      sessionVersion: appUser.sessionVersion,
    })
    .from(appUser)
    .where(
      and(
        eq(appUser.id, user.id),
        eq(appUser.status, "active"),
        eq(appUser.platformRole, "super_admin"),
      ),
    )
    .limit(1);

  const identity = rows[0];

  if (!identity || identity.sessionVersion !== user.sessionVersion) {
    return null;
  }

  return {
    id: identity.id,
    email: identity.email,
    role: "platform_admin",
    sessionVersion: identity.sessionVersion,
  };
}
