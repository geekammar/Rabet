"use server";

import { AuthError } from "next-auth";

import { signIn, signOut } from "@/auth-merchant";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { signInSchema } from "@/lib/auth/schema";
import { merchantPostLoginPath } from "@/lib/merchant/order-link";

/**
 * Merchant sign-in and sign-out Server Actions.
 *
 * The enablement gate runs before Auth.js is called. A successful sign-in
 * opens setup or reconstructs the internal Orders link from a validated ID.
 *
 * The form never reveals whether the email exists, the password was wrong or
 * the account is disabled: every failure returns the same code, and the
 * merchant limiter runs inside `verifyMerchantCredentials` before Argon2.
 */
export type MerchantLoginState = {
  error?: "INVALID_CREDENTIALS" | "UNAVAILABLE";
};

export async function merchantLogin(
  _previous: MerchantLoginState | undefined,
  formData: FormData,
): Promise<MerchantLoginState> {
  if (!isMerchantAppEnabled()) {
    return { error: "UNAVAILABLE" };
  }

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
      redirectTo: merchantPostLoginPath(formData.get("order")),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "INVALID_CREDENTIALS" };
    }

    throw error;
  }

  return { error: "INVALID_CREDENTIALS" };
}

/**
 * Clears the merchant session cookie and returns to the merchant login page.
 * The operator session is not touched, and vice versa.
 */
export async function merchantLogout(): Promise<void> {
  if (!isMerchantAppEnabled()) return;

  await signOut({ redirectTo: "/app/login" });
}
