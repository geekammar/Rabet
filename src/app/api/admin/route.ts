import { NextResponse } from "next/server";

import { privateCacheHeaders } from "@/lib/auth/cache";
import { requireAdmin } from "@/lib/auth/session";

/**
 * Protected Route Handler — the reuse pattern for future API routes.
 *
 * This is deliberately the *only* non-auth route handler in the app; it exists
 * to prove and cover the authorization pattern that later phases (services,
 * orders, payments) will follow, and it is exercised by the test suite.
 *
 * `requireAdmin()` is the same server-only helper used by Server Components
 * and Server Actions, so a Route Handler, a page and an action all share one
 * authorization decision. It redirects to `/login` when there is no session,
 * which inside a Route Handler resolves to a 307 — the tests assert on that
 * rather than on a bespoke status code.
 *
 * The response is marked `private, no-store` because it is session-scoped.
 */
export async function GET() {
  const session = await requireAdmin();

  return NextResponse.json(
    { ok: true, admin: session.email },
    { headers: privateCacheHeaders() },
  );
}
