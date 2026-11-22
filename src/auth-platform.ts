import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { verifyPlatformAdminCredentials } from "@/lib/auth/platform-credentials";

/**
 * Platform Super Admin authentication — a third, independent Auth.js instance.
 *
 * The operator (`src/auth.ts`) and merchant (`src/auth-merchant.ts`) instances
 * are untouched. This configuration uses:
 *
 * - its own handler base path (`/api/platform-auth`);
 * - its own cookie namespace (`rabet-platform.*`), so no session can be read
 *   by another instance;
 * - a database-backed `app_user` check requiring `active` status and the
 *   `super_admin` platform role, with a one-to-one Argon2id credential.
 *
 * The JWT carries only the platform identity id, role and the
 * `session_version` observed at sign-in. `requirePlatformAdmin()` re-reads
 * every eligibility fact on every protected request, so disabling the
 * identity or bumping its session version takes effect without waiting for
 * the JWT to expire.
 */

export const PLATFORM_AUTH_BASE_PATH = "/api/platform-auth";

const PLATFORM_SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

export const { handlers, signIn, signOut, auth } = NextAuth({
  basePath: PLATFORM_AUTH_BASE_PATH,
  session: {
    strategy: "jwt",
    maxAge: PLATFORM_SESSION_MAX_AGE_SECONDS,
  },
  pages: {
    signIn: "/platform/login",
    error: "/platform/login",
  },
  cookies: {
    sessionToken: { name: "rabet-platform.session-token" },
    callbackUrl: { name: "rabet-platform.callback-url" },
    csrfToken: { name: "rabet-platform.csrf-token" },
    pkceCodeVerifier: { name: "rabet-platform.pkce.code_verifier" },
    state: { name: "rabet-platform.state" },
    nonce: { name: "rabet-platform.nonce" },
    webauthnChallenge: { name: "rabet-platform.challenge" },
  },
  providers: [
    Credentials({
      credentials: {
        email: { type: "email", label: "Email" },
        password: { type: "password", label: "Password" },
      },
      authorize: async (credentials) => {
        const identity = await verifyPlatformAdminCredentials(
          credentials?.email,
          credentials?.password,
        );

        return identity ?? null;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const identity = user as typeof user & {
          id?: string;
          sessionVersion?: number;
        };

        if (typeof identity.id === "string") {
          token.platformAdminId = identity.id;
        }
        token.role = "platform_admin";
        if (typeof identity.sessionVersion === "number") {
          token.sessionVersion = identity.sessionVersion;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (
        session.user &&
        token.role === "platform_admin" &&
        typeof token.platformAdminId === "string" &&
        typeof token.sessionVersion === "number"
      ) {
        session.user.id = token.platformAdminId;
        session.user.role = "platform_admin";
        session.user.sessionVersion = token.sessionVersion;
      }

      return session;
    },
  },
});
