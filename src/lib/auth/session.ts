import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth";

/**
 * Server-side authorization helper — the Data Access Layer for auth.
 *
 * This is the *authoritative* check. It is used by Server Components, Server
 * Actions and Route Handlers. `proxy.ts` performs an early optimistic
 * redirect for convenience, but by design it must never be the sole
 * authorization layer (see docs/ARCHITECTURE.md, ADR-010), so every protected
 * path also funnels through here.
 *
 * Why not just check in the layout: a Next.js layout does not re-run on every
 * navigation, and returning `null` from a layout does not stop nested route
 * segments or Server Actions from executing. Centralizing the check in a
 * server-only helper means a new route is protected by calling one function,
 * and a Server Action or Route Handler that forgets it is the only gap.
 *
 * `cache()` deduplicates the underlying `auth()` call within a single request
 * render pass, so a page that calls `requireAdmin()` several times reads the
 * cookie once.
 */

export type AdminSession = {
  email: string;
  role: "admin";
};

/**
 * Returns the authenticated admin session, or `null` when there is none.
 *
 * Use this when a `null` result is meaningful (for example on the public
 * landing page to decide whether to show a "Open dashboard" link). Protected
 * surfaces should call `requireAdmin()` instead.
 */
export const getAdminSession = cache(async (): Promise<AdminSession | null> => {
  const session = await auth();

  // Only a session carrying the admin role counts. A session without the
  // role claim is treated as unauthenticated rather than as a lesser
  // principal — Rabet has exactly one identity and no lesser roles exist.
  if (session?.user?.role !== "admin" || !session.user.email) {
    return null;
  }

  return { email: session.user.email, role: "admin" };
});

/**
 * Asserts an authenticated administrator.
 *
 * Redirects to `/login` (with the current path preserved as `callbackUrl`)
 * when there is no valid admin session. Call this at the top of any protected
 * Server Component, Server Action or Route Handler.
 *
 * The redirect target is fixed and internal, so this function can never be
 * used to build an open redirect.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const session = await getAdminSession();

  if (!session) {
    redirect("/login");
  }

  return session;
}
