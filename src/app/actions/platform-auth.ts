"use server";

import { AuthError } from "next-auth";

import { signIn, signOut } from "@/auth-platform";
import { signInSchema } from "@/lib/auth/schema";

/**
 * Platform Super Admin sign-in and sign-out Server Actions.
 *
 * The destination is fixed and internal; no caller-supplied callback URL is
 * accepted. Every rejection — malformed form, unknown identity, merchant
 * identity, disabled identity, wrong password or unavailable limiter — is
 * collapsed into the same generic code so the form cannot enumerate accounts.
 */
export type PlatformLoginState = {
  error?: "INVALID_CREDENTIALS" | "UNAVAILABLE";
};

export async function platformLogin(
  _previous: PlatformLoginState | undefined,
  formData: FormData,
): Promise<PlatformLoginState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "INVALID_CREDENTIALS" };
  }

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: "/platform/invitations",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "INVALID_CREDENTIALS" };
    }

    throw error;
  }

  // `signIn` throws a NEXT_REDIRECT on success; this line is unreachable.
  return { error: "INVALID_CREDENTIALS" };
}

export async function platformLogout(): Promise<void> {
  await signOut({ redirectTo: "/platform/login" });
}
