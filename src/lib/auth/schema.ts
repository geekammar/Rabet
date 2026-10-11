import { z } from "zod";

/**
 * Sign-in validation schema.
 *
 * Validated on the server inside the Credentials provider's `authorize`
 * function before any password verification runs, so malformed input never
 * reaches the hashing layer. The same schema backs the login Server Action,
 * so client and server cannot drift apart.
 *
 * Password rules are deliberately minimal here: the password *policy* is
 * enforced when the admin generates their hash (see
 * `scripts/generate-admin-hash.mjs`). At sign-in we only assert the shape of
 * the input — a real password is always required, and the maximum length
 * guards against denial-of-service via oversized payloads passed to Argon2.
 */
export const signInSchema = z.object({
  email: z
    .string({ message: "Email is required" })
    .trim()
    .min(1, "Email is required")
    .email("Please enter a valid email address")
    .max(254, "Email is too long")
    .toLowerCase(),
  password: z
    .string({ message: "Password is required" })
    .min(1, "Password is required")
    .max(1024, "Password is too long"),
});

export type SignInInput = z.infer<typeof signInSchema>;
