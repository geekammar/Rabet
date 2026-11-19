import "server-only";

import { verify } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";

import { appUser, merchantCredential } from "@/db/schema";
import {
  getTransactionDb,
  type TransactionDatabase,
} from "@/db/transaction-client";
import { signInSchema } from "@/lib/auth/schema";
import {
  consumeMerchantThrottle,
  merchantGlobalSignInKey,
  merchantThrottleKey,
  resetMerchantThrottle,
} from "@/lib/auth/merchant-throttle";

/**
 * Merchant password verification.
 *
 * Unlike the operator identity, a merchant is a database row: an `app_user`
 * with a one-to-one `merchant_credential` containing an Argon2id PHC hash. The
 * plaintext password is never stored, logged or compared in the clear.
 *
 * Order of operations, all before Argon2:
 * 1. Shape validation (email, bounded password).
 * 2. The per-identity sign-in budget.
 * 3. The coarse global merchant sign-in budget.
 *
 * An unknown email still performs one Argon2 verification against a fixed
 * dummy hash, so a caller cannot enumerate merchants by timing. A disabled
 * user is also verified and then rejected, so disablement does not become a
 * fast-path oracle.
 *
 * The returned identity carries `sessionVersion`, which the Auth.js JWT
 * stores. It is only a starting value: `requireMerchantAccess()` reloads the
 * user, version, membership and store on every protected request.
 */

/** A syntactically valid Argon2id hash of a random string that is never used. */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$IVqmOMF8kb6Oey9CzBxW6g$W1ORGaoNecXUIAAxF5tB3m6gcbC3d/3Wl/TnTfYI/M0";

export type MerchantIdentity = {
  id: string;
  email: string;
  role: "merchant";
  sessionVersion: number;
};

function executorFor(db: TransactionDatabase) {
  return (statement: Parameters<typeof db.execute>[0]) => db.execute(statement);
}

/**
 * Verifies a merchant email/password pair.
 *
 * Returns `null` for every rejection: malformed input, unknown email, wrong
 * password, disabled user, exhausted budget or an unavailable limiter. Throws
 * only on unexpected programming errors, never on a bad credential.
 */
export async function verifyMerchantCredentials(
  rawEmail: unknown,
  rawPassword: unknown,
  options: { db?: TransactionDatabase } = {},
): Promise<MerchantIdentity | null> {
  const parsed = signInSchema.safeParse({
    email: rawEmail,
    password: rawPassword,
  });

  if (!parsed.success) return null;

  const { email, password } = parsed.data;
  const db = options.db ?? getTransactionDb();
  const execute = executorFor(db);
  const identityKey = merchantThrottleKey(email);

  try {
    const [identityAttempt, globalAttempt] = await Promise.all([
      consumeMerchantThrottle(execute, {
        scope: "sign_in",
        key: identityKey,
      }),
      consumeMerchantThrottle(execute, {
        scope: "sign_in_global",
        key: merchantGlobalSignInKey(),
      }),
    ]);

    if (!identityAttempt.allowed || !globalAttempt.allowed) return null;
  } catch {
    console.error(
      "Merchant sign-in throttling is unavailable; denying credential verification.",
    );
    return null;
  }

  let stored: {
    id: string;
    email: string;
    status: string;
    sessionVersion: number;
    passwordHash: string;
  } | null = null;

  try {
    const rows = await db
      .select({
        id: appUser.id,
        email: appUser.email,
        status: appUser.status,
        sessionVersion: appUser.sessionVersion,
        passwordHash: merchantCredential.passwordHash,
      })
      .from(appUser)
      .innerJoin(
        merchantCredential,
        eq(merchantCredential.userId, appUser.id),
      )
      .where(sql`lower(${appUser.email}) = ${email}`)
      .limit(1);

    stored = rows[0] ?? null;
  } catch {
    console.error(
      "Merchant identity lookup is unavailable; denying credential verification.",
    );
    return null;
  }

  const passwordMatches = await verify(
    stored?.passwordHash ?? DUMMY_PASSWORD_HASH,
    password,
  ).catch(() => false);

  if (!stored || !passwordMatches || stored.status !== "active") {
    return null;
  }

  try {
    await resetMerchantThrottle(execute, {
      scope: "sign_in",
      key: identityKey,
    });
  } catch {
    // Best-effort only: the credential pair is valid even if the reset fails.
  }

  return {
    id: stored.id,
    email: stored.email,
    role: "merchant",
    sessionVersion: stored.sessionVersion,
  };
}
