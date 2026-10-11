"use server";

import { AuthError } from "next-auth";

import { signIn, signOut } from "@/auth";
import { safeLoginRedirect } from "@/lib/auth/redirect";
import { signInSchema } from "@/lib/auth/schema";

/**
 * Shape returned to the login form. Only a generic `message` is ever sent to
 * the client — never which field failed or whether the admin email exists.
 */
export type LoginState = {
  message?: string;
};

/**
 * Login Server Action.
 *
 * Runs entirely on the server. The form is validated again here (never trust
 * the client) before `signIn` hands the credentials to the Credentials
 * provider's `authorize`, which verifies the Argon2id hash.
 *
 * Failure modes all collapse to one generic message so the response leaks no
 * signal about the admin identity:
 * - invalid form → generic message
 * - `CredentialsSignin` (bad email or password, or admin not configured) →
 *   generic message
 * - any other unexpected error → generic message
 *
 * The destination is passed through `safeLoginRedirect()` so an attacker
 * cannot steer the post-login redirect off-site.
 */
export async function login(
  _prevState: LoginState | undefined,
  formData: FormData,
): Promise<LoginState> {
  const rawCallbackUrl = formData.get("callbackUrl");
  const callbackUrl = safeLoginRedirect(rawCallbackUrl);

  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { message: "Incorrect email or password." };
  }

  try {
    // `redirectTo` is Auth.js's post-login destination. Auth.js itself also
    // validates it against the request origin; `safeLoginRedirect` is the
    // application-layer allowlist that runs first.
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: callbackUrl,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      // `CredentialsSignin` covers every rejection from `authorize`, including
      // the "admin not configured" fail-closed path. Everything else
      // (misconfiguration, transport errors) also surfaces as a generic
      // message rather than an internal detail.
      return { message: "Incorrect email or password." };
    }
    // Anything else is re-thrown so Next.js surfaces a real 500 instead of
    // silently rendering a success-looking page.
    throw error;
  }

  // `signIn` throws a NEXT_REDIRECT on success; this line is unreachable.
  return { message: "Signed in." };
}

/**
 * Logout Server Action.
 *
 * `signOut` clears the session cookie server-side and redirects to `/login`.
 * Because the cookie is deleted (not just ignored), navigating back or
 * refreshing after logout cannot restore access — the session material is
 * gone from the browser.
 */
export async function logout(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
