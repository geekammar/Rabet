import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { StorefrontProfile } from "@/lib/merchant/storefront-profile-fields";

/**
 * Tenant identity foundation (S1.1).
 *
 * Three additive tenant tables establish the ownership chain
 * `app_user -> store_membership -> store`. Phase 2A adds two more additive
 * tables for merchant credentials and invitations. The pilot still runs one
 * store, one application and one shared database; nothing here activates
 * merchant authentication, onboarding UI, public routes or bot provisioning.
 *
 * The model is intentionally many-to-many: an `app_user` may hold a membership
 * in more than one store, and a store may have more than one member. No global
 * unique constraint on `store_membership.user_id` is allowed, so a future
 * multi-store owner needs no migration to the relationship itself. The MVP
 * service enforces one active membership per merchant and one active owner per
 * store; the schema deliberately keeps the relationship flexible.
 *
 * `app_user` stores identity only. Merchant password hashes live in the
 * one-to-one `merchant_credential` table and invitation token digests live in
 * `merchant_invitation`; the existing environment-backed operator identity,
 * credentials, cookies and login path are unchanged.
 *
 * `store.slug` is a canonical lowercase ASCII slug: one or more alphanumeric
 * segments joined by single hyphens. Email is stored trimmed and is unique
 * case-insensitively.
 */

export type StoreStatus = "onboarding" | "active" | "suspended";

export const STORE_STATUSES: readonly StoreStatus[] = [
  "onboarding",
  "active",
  "suspended",
];

/** `store` — the future tenant boundary. No row is seeded by this migration. */
export const store = pgTable(
  "store",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    status: text("status").notNull().default("onboarding"),
    // Optional direct-contact account for the managed storefront. `NULL` means
    // the merchant has not configured (or explicitly cleared) the contact, so
    // every existing store remains valid without a backfill.
    telegramSupportUsername: text("telegram_support_username"),
    storefrontProfile: jsonb("storefront_profile").$type<StorefrontProfile>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("store_name_not_empty_check", sql`btrim(${table.name}) <> ''`),
    check(
      "store_slug_format_check",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      "store_status_check",
      sql`${table.status} IN ('onboarding', 'active', 'suspended')`,
    ),
    check(
      "store_telegram_support_username_format_check",
      sql`${table.telegramSupportUsername} IS NULL OR ${table.telegramSupportUsername} ~ '^[A-Za-z][A-Za-z0-9_]{4,31}$'`,
    ),
  ],
);

export type AppUserStatus = "active" | "disabled";

export const APP_USER_STATUSES: readonly AppUserStatus[] = [
  "active",
  "disabled",
];

export type PlatformRole = "user" | "super_admin";

export const PLATFORM_ROLES: readonly PlatformRole[] = ["user", "super_admin"];

/**
 * `app_user` — a future merchant/platform identity, unrelated to the existing
 * single administrator for now.
 *
 * Email is stored exactly as written after the database rejects surrounding
 * whitespace (`email = btrim(email)`), and uniqueness is case-insensitive
 * through a unique expression index on `lower(email)`, so `Owner@example.com`
 * and `owner@example.com` cannot both exist.
 */
export const appUser = pgTable(
  "app_user",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    status: text("status").notNull().default("active"),
    platformRole: text("platform_role").notNull().default("user"),
    sessionVersion: integer("session_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("app_user_email_lower_unique").on(sql`lower(${table.email})`),
    check("app_user_email_not_empty_check", sql`btrim(${table.email}) <> ''`),
    check(
      "app_user_email_trimmed_check",
      sql`${table.email} = btrim(${table.email})`,
    ),
    check("app_user_status_check", sql`${table.status} IN ('active', 'disabled')`),
    check(
      "app_user_platform_role_check",
      sql`${table.platformRole} IN ('user', 'super_admin')`,
    ),
    check(
      "app_user_session_version_nonnegative_check",
      sql`${table.sessionVersion} >= 0`,
    ),
  ],
);

export type StoreMembershipRole = "owner";

export const STORE_MEMBERSHIP_ROLES: readonly StoreMembershipRole[] = ["owner"];

export type StoreMembershipStatus = "active" | "revoked";

export const STORE_MEMBERSHIP_STATUSES: readonly StoreMembershipStatus[] = [
  "active",
  "revoked",
];

/**
 * `store_membership` — the ownership link between an identity and a store.
 *
 * Deletion is restricted on both sides so removing a user or a store can never
 * silently destroy ownership history. `UNIQUE(store_id, user_id)` allows one
 * membership per pair while leaving one user free to join many stores.
 */
export const storeMembership = pgTable(
  "store_membership",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    role: text("role").notNull().default("owner"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("store_membership_store_user_unique").on(
      table.storeId,
      table.userId,
    ),
    check("store_membership_role_check", sql`${table.role} IN ('owner')`),
    check(
      "store_membership_status_check",
      sql`${table.status} IN ('active', 'revoked')`,
    ),
  ],
);

/**
 * `merchant_credential` — one Argon2id password hash per merchant identity.
 *
 * The credential is a separate table rather than an `app_user` column so every
 * existing identity row (including Super Admin fixtures) remains valid without
 * a backfill. The service that creates credentials is the only writer, and the
 * database check rejects any stored value that is not an Argon2id PHC string.
 * The plaintext password is never stored.
 */
export const merchantCredential = pgTable(
  "merchant_credential",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("merchant_credential_user_id_unique").on(table.userId),
    check(
      "merchant_credential_password_hash_not_empty_check",
      sql`btrim(${table.passwordHash}) <> ''`,
    ),
    check(
      "merchant_credential_password_hash_argon2id_check",
      sql`${table.passwordHash} LIKE '$argon2id$%'`,
    ),
  ],
);

/**
 * `merchant_invitation` — a single-use, digest-only invitation to one store.
 *
 * The raw token is returned once to the authorized server caller and is never
 * stored. `token_digest` is a SHA-256 hex digest; the unique index makes replay
 * impossible even if two acceptance calls race. The invited email is stored
 * trimmed and lowercased to match the case-insensitive `app_user` identity key.
 *
 * Pending invitations are additive: a store may have more than one invitation
 * while no owner accepts, and the service serializes acceptance so exactly one
 * active owner and one consumed invitation can result. `accepted_at` and
 * `revoked_at` are terminal markers and are mutually exclusive.
 *
 * The issuing and revoking platform identities are retained on the row, so the
 * invitation history is itself the audit record. `revoked_by_user_id` is
 * nullable because rows revoked before this column existed have no recorded
 * actor; new revocations always write the authenticated Super Admin.
 */
export const merchantInvitation = pgTable(
  "merchant_invitation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "restrict" }),
    invitedEmail: text("invited_email").notNull(),
    tokenDigest: text("token_digest").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" })
      .notNull(),
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => appUser.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("merchant_invitation_token_digest_unique").on(
      table.tokenDigest,
    ),
    index("merchant_invitation_store_idx").on(table.storeId),
    index("merchant_invitation_invited_email_idx").on(table.invitedEmail),
    check(
      "merchant_invitation_email_not_empty_check",
      sql`btrim(${table.invitedEmail}) <> ''`,
    ),
    check(
      "merchant_invitation_email_normalized_check",
      sql`${table.invitedEmail} = lower(btrim(${table.invitedEmail}))`,
    ),
    check(
      "merchant_invitation_token_digest_format_check",
      sql`${table.tokenDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "merchant_invitation_expiry_after_creation_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "merchant_invitation_terminal_state_check",
      sql`NOT (${table.acceptedAt} IS NOT NULL AND ${table.revokedAt} IS NOT NULL)`,
    ),
  ],
);
