import "server-only";

import crypto from "node:crypto";

import { hash } from "@node-rs/argon2";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import * as schema from "@/db/schema";
import {
  appUser,
  merchantCredential,
  merchantInvitation,
  store,
  storeMembership,
} from "@/db/schema";

export type MerchantInvitationDb = PostgresJsDatabase<typeof schema>;
type MerchantInvitationTx = Parameters<
  Parameters<MerchantInvitationDb["transaction"]>[0]
>[0];
type MerchantInvitationExecutor = Pick<MerchantInvitationDb, "select">;

export type MerchantInvitationErrorCode =
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "INVALID_CREDENTIAL"
  | "INVITATION_REJECTED"
  | "CONFLICT"
  | "OPERATION_FAILED";

export class MerchantInvitationError extends Error {
  readonly code: MerchantInvitationErrorCode;

  constructor(
    code: MerchantInvitationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);

    this.name = "MerchantInvitationError";
    this.code = code;
  }
}

export const MERCHANT_INVITATION_REJECTION_MESSAGE =
  "This invitation is not valid or can no longer be used.";
export const MERCHANT_INVITATION_PASSWORD_MESSAGE =
  "The password must be between 12 and 1024 characters.";

export const MERCHANT_INVITATION_TTL_HOURS = 168;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const storeNameSchema = z.string().trim().min(1).max(255);
const storeSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(100)
  .regex(STORE_SLUG_PATTERN);
const invitedEmailSchema = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .email()
  .toLowerCase();
const passwordSchema = z.string().min(12).max(1024);

const HASH_OPTIONS = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export type IssueMerchantInvitationInput = {
  actorUserId: unknown;
  storeName: unknown;
  storeSlug?: unknown;
  invitedEmail: unknown;
};

export type IssuedMerchantInvitation = {
  invitationId: string;
  storeId: string;
  storeName: string;
  storeSlug: string;
  invitedEmail: string;
  expiresAt: Date;
  token: string;
};

export type RevokeMerchantInvitationInput = {
  actorUserId: unknown;
  invitationId: unknown;
};

export type RevokedMerchantInvitation = {
  invitationId: string;
  storeId: string;
  revokedByUserId: string;
};

export type AcceptMerchantInvitationInput = {
  token: unknown;
  password: unknown;
};

export type AcceptedMerchantInvitation = {
  userId: string;
  storeId: string;
  membershipId: string;
  email: string;
};

export type MerchantInvitationPreview = {
  invitationId: string;
  storeId: string;
  storeName: string;
  invitedEmail: string;
  expiresAt: Date;
};

function rejection(cause?: unknown): MerchantInvitationError {
  return new MerchantInvitationError(
    "INVITATION_REJECTED",
    MERCHANT_INVITATION_REJECTION_MESSAGE,
    { cause },
  );
}

function forbidden(): MerchantInvitationError {
  return new MerchantInvitationError(
    "FORBIDDEN",
    "This operation requires an active platform Super Admin.",
  );
}

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;

  for (
    let depth = 0;
    depth < 8 && current !== null && typeof current === "object";
    depth += 1
  ) {
    if ("code" in current) {
      const code = (current as { code?: unknown }).code;

      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }

    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }

  return undefined;
}

function digestToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function createToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function parseToken(raw: unknown): string {
  if (typeof raw !== "string" || !TOKEN_PATTERN.test(raw)) {
    throw rejection();
  }

  return raw;
}

function tryParseToken(raw: unknown): string | null {
  return typeof raw === "string" && TOKEN_PATTERN.test(raw) ? raw : null;
}

function parseInvitationId(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) {
    throw new MerchantInvitationError(
      "INVALID_INPUT",
      "A valid invitation id is required.",
    );
  }

  return raw;
}

function normalizeEmail(raw: unknown): string {
  const parsed = invitedEmailSchema.safeParse(raw);

  if (!parsed.success) {
    throw new MerchantInvitationError(
      "INVALID_INPUT",
      "A valid invited email is required.",
      { cause: parsed.error },
    );
  }

  return parsed.data;
}

function normalizeStoreName(raw: unknown): string {
  const parsed = storeNameSchema.safeParse(raw);

  if (!parsed.success) {
    throw new MerchantInvitationError(
      "INVALID_INPUT",
      "A store name is required.",
      { cause: parsed.error },
    );
  }

  return parsed.data;
}

function deriveStoreSlug(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");

  return base.length > 0
    ? base
    : `store-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeStoreSlug(name: string, raw: unknown): string {
  if (raw === undefined || raw === null) return deriveStoreSlug(name);

  const parsed = storeSlugSchema.safeParse(raw);

  if (!parsed.success) {
    throw new MerchantInvitationError(
      "INVALID_INPUT",
      "A canonical lowercase store slug is required.",
      { cause: parsed.error },
    );
  }

  return parsed.data;
}

function normalizePassword(raw: unknown): string {
  const parsed = passwordSchema.safeParse(raw);

  if (!parsed.success) {
    throw new MerchantInvitationError(
      "INVALID_CREDENTIAL",
      MERCHANT_INVITATION_PASSWORD_MESSAGE,
      { cause: parsed.error },
    );
  }

  return parsed.data;
}

async function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

async function requireActiveSuperAdmin(
  executor: MerchantInvitationExecutor,
  actorUserId: unknown,
): Promise<{ id: string }> {
  if (typeof actorUserId !== "string" || !UUID_PATTERN.test(actorUserId)) {
    throw forbidden();
  }

  const rows = await executor
    .select({ id: appUser.id })
    .from(appUser)
    .where(
      and(
        eq(appUser.id, actorUserId),
        eq(appUser.status, "active"),
        eq(appUser.platformRole, "super_admin"),
      ),
    )
    .limit(1);

  if (rows.length !== 1) throw forbidden();

  return rows[0];
}

async function lockInvitationEmail(
  tx: MerchantInvitationTx,
  email: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`merchant-invitation-email:${email}`}, 0))`,
  );
}

async function lockInvitationStore(
  tx: MerchantInvitationTx,
  storeId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`merchant-invitation-store:${storeId}`}, 0))`,
  );
}

export async function issueMerchantInvitation(
  db: MerchantInvitationDb,
  input: IssueMerchantInvitationInput,
): Promise<IssuedMerchantInvitation> {
  const storeName = normalizeStoreName(input.storeName);
  const storeSlug = normalizeStoreSlug(storeName, input.storeSlug);
  const invitedEmail = normalizeEmail(input.invitedEmail);
  const token = createToken();
  const tokenDigest = digestToken(token);

  try {
    return await db.transaction(async (tx) => {
      const actor = await requireActiveSuperAdmin(tx, input.actorUserId);

      const [createdStore] = await tx
        .insert(store)
        .values({ name: storeName, slug: storeSlug, status: "onboarding" })
        .returning({ id: store.id, name: store.name, slug: store.slug });

      const [invitation] = await tx
        .insert(merchantInvitation)
        .values({
          storeId: createdStore.id,
          invitedEmail,
          tokenDigest,
          expiresAt: sql`now() + make_interval(hours => ${MERCHANT_INVITATION_TTL_HOURS})`,
          invitedByUserId: actor.id,
        })
        .returning({
          id: merchantInvitation.id,
          storeId: merchantInvitation.storeId,
          invitedEmail: merchantInvitation.invitedEmail,
          expiresAt: merchantInvitation.expiresAt,
        });

      return {
        invitationId: invitation.id,
        storeId: invitation.storeId,
        storeName: createdStore.name,
        storeSlug: createdStore.slug,
        invitedEmail: invitation.invitedEmail,
        expiresAt: invitation.expiresAt,
        token,
      };
    });
  } catch (error) {
    if (error instanceof MerchantInvitationError) throw error;

    if (sqlState(error) === "23505") {
      throw new MerchantInvitationError(
        "CONFLICT",
        "A store with this slug already exists.",
        { cause: error },
      );
    }

    throw new MerchantInvitationError(
      "OPERATION_FAILED",
      "The invitation could not be issued.",
      { cause: error },
    );
  }
}

export async function revokeMerchantInvitation(
  db: MerchantInvitationDb,
  input: RevokeMerchantInvitationInput,
): Promise<RevokedMerchantInvitation> {
  const invitationId = parseInvitationId(input.invitationId);

  try {
    return await db.transaction(async (tx) => {
      const actor = await requireActiveSuperAdmin(tx, input.actorUserId);

      const rows = await tx
        .select({
          id: merchantInvitation.id,
          storeId: merchantInvitation.storeId,
          acceptedAt: merchantInvitation.acceptedAt,
          revokedAt: merchantInvitation.revokedAt,
          expiresAt: merchantInvitation.expiresAt,
        })
        .from(merchantInvitation)
        .where(eq(merchantInvitation.id, invitationId))
        .limit(1)
        .for("update");

      if (rows.length !== 1) throw rejection();

      const invitation = rows[0];

      if (
        invitation.acceptedAt !== null ||
        invitation.revokedAt !== null ||
        invitation.expiresAt.getTime() <= Date.now()
      ) {
        throw rejection();
      }

      const updated = await tx
        .update(merchantInvitation)
        .set({
          revokedAt: sql`clock_timestamp()`,
          revokedByUserId: actor.id,
        })
        .where(
          and(
            eq(merchantInvitation.id, invitation.id),
            isNull(merchantInvitation.acceptedAt),
            isNull(merchantInvitation.revokedAt),
            sql`${merchantInvitation.expiresAt} > clock_timestamp()`,
          ),
        )
        .returning({
          invitationId: merchantInvitation.id,
          storeId: merchantInvitation.storeId,
          revokedByUserId: merchantInvitation.revokedByUserId,
        });

      if (updated.length !== 1) throw rejection();

      const revoked = updated[0];

      if (revoked.revokedByUserId === null) throw rejection();

      return {
        invitationId: revoked.invitationId,
        storeId: revoked.storeId,
        revokedByUserId: revoked.revokedByUserId,
      };
    });
  } catch (error) {
    if (error instanceof MerchantInvitationError) throw error;

    throw rejection(error);
  }
}

/**
 * Read-only invitation inspection.
 *
 * Returns the invited email and store name only while the invitation is
 * pending, unexpired and unrevoked. Invalid, expired, revoked and consumed
 * invitations all return `null`, so callers can serve one generic response.
 *
 * This function never writes: opening, refreshing or prefetching an invitation
 * link cannot consume it. Acceptance remains the transactional service's job.
 */
export async function previewMerchantInvitation(
  db: MerchantInvitationDb,
  rawToken: unknown,
): Promise<MerchantInvitationPreview | null> {
  const token = tryParseToken(rawToken);

  if (token === null) return null;

  const rows = await db
    .select({
      invitationId: merchantInvitation.id,
      storeId: merchantInvitation.storeId,
      storeName: store.name,
      invitedEmail: merchantInvitation.invitedEmail,
      expiresAt: merchantInvitation.expiresAt,
    })
    .from(merchantInvitation)
    .innerJoin(store, eq(store.id, merchantInvitation.storeId))
    .where(
      and(
        eq(merchantInvitation.tokenDigest, digestToken(token)),
        isNull(merchantInvitation.acceptedAt),
        isNull(merchantInvitation.revokedAt),
        sql`${merchantInvitation.expiresAt} > clock_timestamp()`,
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function acceptMerchantInvitation(
  db: MerchantInvitationDb,
  input: AcceptMerchantInvitationInput,
): Promise<AcceptedMerchantInvitation> {
  const token = parseToken(input.token);
  const password = normalizePassword(input.password);
  const tokenDigest = digestToken(token);
  let passwordHash: string;

  try {
    passwordHash = await hashPassword(password);
  } catch (error) {
    throw new MerchantInvitationError(
      "OPERATION_FAILED",
      "The invitation could not be used.",
      { cause: error },
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: merchantInvitation.id,
          storeId: merchantInvitation.storeId,
          invitedEmail: merchantInvitation.invitedEmail,
          acceptedAt: merchantInvitation.acceptedAt,
          revokedAt: merchantInvitation.revokedAt,
          expiresAt: merchantInvitation.expiresAt,
        })
        .from(merchantInvitation)
        .where(eq(merchantInvitation.tokenDigest, tokenDigest))
        .limit(1)
        .for("update");

      if (rows.length !== 1) throw rejection();

      const invitation = rows[0];

      if (
        invitation.acceptedAt !== null ||
        invitation.revokedAt !== null
      ) {
        throw rejection();
      }

      await lockInvitationEmail(tx, invitation.invitedEmail);
      await lockInvitationStore(tx, invitation.storeId);

      if (invitation.expiresAt.getTime() <= Date.now()) throw rejection();

      const existingIdentity = await tx
        .select({ id: appUser.id })
        .from(appUser)
        .where(sql`lower(${appUser.email}) = ${invitation.invitedEmail}`)
        .limit(1);

      if (existingIdentity.length !== 0) throw rejection();

      const existingOwner = await tx
        .select({ id: storeMembership.id })
        .from(storeMembership)
        .where(
          and(
            eq(storeMembership.storeId, invitation.storeId),
            eq(storeMembership.role, "owner"),
            eq(storeMembership.status, "active"),
          ),
        )
        .limit(1);

      if (existingOwner.length !== 0) throw rejection();

      const [identity] = await tx
        .insert(appUser)
        .values({ email: invitation.invitedEmail })
        .returning({ id: appUser.id });

      await tx.insert(merchantCredential).values({
        userId: identity.id,
        passwordHash,
      });

      const [membership] = await tx
        .insert(storeMembership)
        .values({
          storeId: invitation.storeId,
          userId: identity.id,
          role: "owner",
          status: "active",
        })
        .returning({ id: storeMembership.id });

      const consumed = await tx
        .update(merchantInvitation)
        .set({ acceptedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(merchantInvitation.id, invitation.id),
            isNull(merchantInvitation.acceptedAt),
            isNull(merchantInvitation.revokedAt),
            sql`${merchantInvitation.expiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ id: merchantInvitation.id });

      if (consumed.length !== 1) throw rejection();

      return {
        userId: identity.id,
        storeId: invitation.storeId,
        membershipId: membership.id,
        email: invitation.invitedEmail,
      };
    });
  } catch (error) {
    if (error instanceof MerchantInvitationError) throw error;

    throw rejection(error);
  }
}
