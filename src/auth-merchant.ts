import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { verifyMerchantCredentials } from "@/lib/auth/merchant-credentials";

/**
 * Merchant authentication — a second, independent Auth.js instance.
 *
 * The operator instance in `src/auth.ts` is intentionally untouched: a
 * merchant session is not an operator session and an operator session is not a
 * merchant session. This config uses:
 *
 * - its own handler base path (`/api/merchant-auth`);
 * - its own cookie namespace (`rabet-merchant.*`), so the two encrypted JWTs
 *   never overwrite or read each other;
 * - a database-backed `app_user` + `merchant_credential` check instead of the
 *   environment-configured operator identity.
 *
 * The JWT carries the merchant user id, role and the `session_version` at
 * sign-in. It deliberately does **not** carry a store id: a store is resolved
 * from exactly one active membership on every protected request (see
 * `src/lib/auth/merchant-session.ts`), so revocation, disablement and
 * suspension take effect without waiting for JWT expiry.
 *
 * The credentials provider runs the durable merchant limiter before Argon2
 * (`verifyMerchantCredentials`), not the operator's singleton budget.
 */

export const MERCHANT_AUTH_BASE_PATH = "/api/merchant-auth";

const MERCHANT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export const { handlers, signIn, signOut, auth } = NextAuth({
  basePath: MERCHANT_AUTH_BASE_PATH,
  session: {
    strategy: "jwt",
    maxAge: MERCHANT_SESSION_MAX_AGE_SECONDS,
  },
  pages: {
    signIn: "/app/login",
    error: "/app/login",
  },
  cookies: {
    sessionToken: { name: "rabet-merchant.session-token" },
    callbackUrl: { name: "rabet-merchant.callback-url" },
    csrfToken: { name: "rabet-merchant.csrf-token" },
    pkceCodeVerifier: { name: "rabet-merchant.pkce.code_verifier" },
    state: { name: "rabet-merchant.state" },
    nonce: { name: "rabet-merchant.nonce" },
    webauthnChallenge: { name: "rabet-merchant.challenge" },
  },
  providers: [
    Credentials({
      credentials: {
        email: { type: "email", label: "Email" },
        password: { type: "password", label: "Password" },
      },
      authorize: async (credentials) => {
        const identity = await verifyMerchantCredentials(
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

        if (typeof identity.id === "string") token.merchantId = identity.id;
        token.role = "merchant";
        if (typeof identity.sessionVersion === "number") {
          token.sessionVersion = identity.sessionVersion;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (
        session.user &&
        token.role === "merchant" &&
        typeof token.merchantId === "string" &&
        typeof token.sessionVersion === "number"
      ) {
        session.user.id = token.merchantId;
        session.user.role = "merchant";
        session.user.sessionVersion = token.sessionVersion;
      }

      return session;
    },
  },
});
