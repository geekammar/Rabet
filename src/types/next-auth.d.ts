import "next-auth";

/**
 * Type augmentation for Auth.js.
 *
 * The operator instance (`src/auth.ts`) carries the `admin` role. The separate
 * merchant instance (`src/auth-merchant.ts`) carries `merchant`, the
 * `app_user` id and the sign-in `session_version`; it never carries a store id.
 * Each instance reads only its own cookie namespace.
 *
 * Only non-sensitive claims are added. Passwords, hashes and secrets are never
 * placed on the token or the session.
 */

declare module "next-auth" {
  interface User {
    role?: "admin" | "merchant";
    sessionVersion?: number;
  }

  interface Session {
    user: {
      id?: string;
      email?: string | null;
      role?: "admin" | "merchant";
      sessionVersion?: number;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    role?: "admin" | "merchant";
    merchantId?: string;
    sessionVersion?: number;
  }
}
