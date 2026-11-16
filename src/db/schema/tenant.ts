import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Tenant identity foundation (S1.1).
 *
 * Three additive tables establish the ownership chain
 * `app_user -> store_membership -> store` without changing any existing
 * business table. The pilot still runs one store, one application and one
 * shared database; nothing here activates merchant authentication, onboarding,
 * invitations or bot provisioning.
 *
 * The model is intentionally many-to-many: an `app_user` may hold a membership
 * in more than one store, and a store may have more than one member. No global
 * unique constraint on `store_membership.user_id` is allowed, so a future
 * multi-store owner needs no migration to the relationship itself.
 *
 * `app_user` stores identity only. Passwords, hashes, invitation tokens and
 * secrets are out of scope; the existing environment-backed administrator is
 * unchanged.
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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("store_name_not_empty_check", sql`btrim(${table.name}) <> ''`),
    check("store_slug_not_empty_check", sql`btrim(${table.slug}) <> ''`),
    check(
      "store_status_check",
      sql`${table.status} IN ('onboarding', 'active', 'suspended')`,
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
 * Email uniqueness is case-insensitive at the database level through a unique
 * expression index on `lower(email)`, so `Owner@example.com` and
 * `owner@example.com` cannot both exist.
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
