import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { verifyAdminCredentials } from "@/lib/auth/credentials";

/**
 * Rabet authentication — single administrator, no database.
 *
 * Auth.js v5 (`next-auth@5.0.0-beta.32`) was chosen because it is the only
 * release line that declares support for Next.js 16 (see its `peerDependencies`
 * `next: ^14 || ^15 || ^16`) and its documentation explicitly covers the
 * Next.js 16 `middleware.ts` → `proxy.ts` rename. The current stable line
 * (`next-auth@4`) does not support Next.js 16.
 *
 * Session strategy: **stateless encrypted JWT**. With no adapter configured,
 * Auth.js defaults to `"jwt"` and stores the session in an encrypted,
 * `HttpOnly`, `Secure` (under HTTPS), `SameSite=lax` cookie named
 * `__Secure-authjs.session-token`. Encryption uses `AUTH_SECRET`; we never
 * hand-roll JWT or crypto code.
 *
 * Security posture:
 * - One administrator, declared by `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`.
 * - No registration, no password reset, no user management.
 * - The `authorized` callback powers the optimistic `proxy.ts` redirect; the
 *   authoritative check lives in `requireAdmin()` (`src/lib/auth/session.ts`),
 *   which is what Server Components, Server Actions and Route Handlers call.
 */

export const { handlers, signIn, signOut, auth } = NextAuth({
  // No `adapter` is configured, so the session strategy is the database-free
  // encrypted JWT strategy. Sessions are therefore stateless: see the
  // "limitations" notes in README.md / docs/ARCHITECTURE.md (ADR-009) for why
  // that means sessions cannot be centrally revoked before they expire.
  session: {
    strategy: "jwt",
    // 7 days. A short-ish window limits the blast radius of a stolen cookie,
    // while staying long enough for the installed PWA to be usable day to day.
    // The proxy rotates (extends) the session on activity, so an admin using
    // the dashboard regularly is not forced back to /login every 7 days.
    maxAge: 60 * 60 * 24 * 7,
  },
  // Custom sign-in page. Auth.js's built-in pages are bypassed entirely.
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    Credentials({
      // Field shapes consumed by the sign-in form. The values are validated
      // server-side in `authorize` via the Zod schema.
      credentials: {
        email: { type: "email", label: "Email" },
        password: { type: "password", label: "Password" },
      },
      authorize: async (credentials) => {
        const email = credentials?.email;
        const password = credentials?.password;

        // `verifyAdminCredentials` returns `null` for *every* failure mode —
        // malformed input, missing configuration, unknown email, wrong
        // password — so no caller can tell which part was wrong.
        const user = await verifyAdminCredentials(email, password);

        return user ?? null;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // On sign-in, `user` is the object returned by `authorize`. Persist only
      // the minimal, non-sensitive identity claim onto the token: a stable
      // `role` used for authorization, and `email` for display. The plaintext
      // password and the hash are never placed on the token.
      if (user) {
        token.role = "admin";
      }
      return token;
    },
    async session({ session, token }) {
      // Expose the minimal role claim to Server Components. `session.user`
      // never carries the password hash or any secret material.
      if (token.role === "admin" && session.user) {
        session.user.role = "admin";
      }
      return session;
    },
  },
});
