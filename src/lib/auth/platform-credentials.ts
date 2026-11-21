import "server-only";

import { verify } from "@node-rs/argon2";
import { sql } from "drizzle-orm";

import { appUser, merchantCredential } from "@/db/schema";
import {
  getTransactionDb,
  type TransactionDatabase,
} from "@/db/transaction-client";
import {
  consumeMerchantThrottle,
  merchantThrottleKey,
  resetMerchantThrottle,
} from "@/lib/auth/merchant-throttle";
import { signInSchema } from "@/lib/auth/schema";

/**
 * Credential verification for a named platform Super Admin.
 *
 * A platform administrator is a database row, not the environment-configured
 * deployment operator: an active `app_user` with
 * `platform_role = 'super_admin'` and a one-to-one `merchant_credential`
 * Argon2id hash. A merchant identity can never pass this check, and a
 * Super Admin never gains merchant eligibility (`resolveMerchantEligibility`
 * requires the plain `user` role).
 *
 * The durable limiter runs before Argon2. Platform attempts use their own
 * coarse global key and their own per-identity key namespace inside the
 * existing throttle table, so merchant traffic and platform traffic do not
 * share an identity bucket. An unknown email still performs one Argon2
 * verification against a fixed dummy hash, so callers cannot enumerate
 * platform administrators by timing.
 */

/** A syntactically valid Argon2id hash of a random string that is never used. */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$IVqmOMF8kb6Oey9CzBxW6g$W1ORGaoNecXUIAAxF5tB3m6gcbC3d/3Wl/TnTfYI/M0";

export type PlatformAdminIdentity = {
  id: string;
  email: string;
  role: "platform_admin";
  sessionVersion: number;
};

function executorFor(db: TransactionDatabase) {
  return (statement: Parameters<typeof db.execute>[0]) => db.execute(statement);
}

function platformGlobalSignInKey(): string {
  return merchantThrottleKey("platform-admin-global");
}

function platformIdentitySignInKey(email: string): string {
  return merchantThrottleKey(`platform-admin:${email}`);
}

/**
 * Verifies a platform administrator email/password pair.
 *
 * Returns `null` for every rejection: malformed input, unknown email, wrong
 * password, disabled identity, a merchant (non-Super-Admin) identity,
 * exhausted budget or an unavailable limiter. It throws only on unexpected
 * programming errors.
 */
export async function verifyPlatformAdminCredentials(
  rawEmail: unknown,
  rawPassword: unknown,
  options: { db?: TransactionDatabase } = {},
): Promise<PlatformAdminIdentity | null> {
  const parsed = signInSchema.safeParse({
    email: rawEmail,
    password: rawPassword,
  });

  if (!parsed.success) return null;

  const { email, password } = parsed.data;
  const db = options.db ?? getTransactionDb();
  const execute = executorFor(db);
  const identityKey = platformIdentitySignInKey(email);

  try {
    const globalAttempt = await consumeMerchantThrottle(execute, {
      scope: "sign_in_global",
      key: platformGlobalSignInKey(),
    });

    if (!globalAttempt.allowed) return null;

    const identityAttempt = await consumeMerchantThrottle(execute, {
      scope: "sign_in",
      key: identityKey,
    });

    if (!identityAttempt.allowed) return null;
  } catch {
    console.error(
      "Platform sign-in throttling is unavailable; denying credential verification.",
    );
    return null;
  }

  let stored:
    | {
        id: string;
        email: string;
        status: string;
        platformRole: string;
        sessionVersion: number;
        passwordHash: string;
      }
    | null = null;

  try {
    const rows = await db
      .select({
        id: appUser.id,
        email: appUser.email,
        status: appUser.status,
        platformRole: appUser.platformRole,
        sessionVersion: appUser.sessionVersion,
        passwordHash: merchantCredential.passwordHash,
      })
      .from(appUser)
      .innerJoin(
        merchantCredential,
        sql`${merchantCredential.userId} = ${appUser.id}`,
      )
      .where(sql`lower(${appUser.email}) = ${email}`)
      .limit(1);

    stored = rows[0] ?? null;
  } catch {
    console.error(
      "Platform identity lookup is unavailable; denying credential verification.",
    );
    return null;
  }

  const passwordMatches = await verify(
    stored?.passwordHash ?? DUMMY_PASSWORD_HASH,
    password,
  ).catch(() => false);

  if (!stored || !passwordMatches) return null;

  if (stored.status !== "active" || stored.platformRole !== "super_admin") {
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
    role: "platform_admin",
    sessionVersion: stored.sessionVersion,
  };
}
