import "next-auth";

/**
 * Type augmentation for Auth.js.
 *
 * The session token carries a single role claim (`"admin"`), which is set in
 * the `jwt` callback in `src/auth.ts` and surfaced through the `session`
 * callback. This keeps `session.user.role` type-safe across the app.
 *
 * Only non-sensitive claims are added. Passwords, hashes and secrets are never
 * placed on the token or the session.
 */

declare module "next-auth" {
  interface User {
    role?: "admin";
  }

  interface Session {
    user: {
      email?: string | null;
      role?: "admin";
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    role?: "admin";
  }
}
