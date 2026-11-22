/**
 * The complete Drizzle schema for Rabet, grouped by the domains of
 * DATA_MODEL.md §2.
 *
 * Twenty-four tables in nine domains — Configuration, Content, Catalog,
 * Buttons, People, Conversations, Integration, Tenant, Security — and no
 * financial entity anywhere (ADR-013). Import this barrel from the client and
 * from tests; never import an individual schema module, so a table cannot be
 * silently left out of the client's schema map (which is what makes
 * `db.query.*` relation helpers work).
 *
 * The Tenant domain (`store`, `app_user`, `store_membership`) is the additive
 * foundation for the future invite-only SaaS. Phase 2A adds the internal
 * `merchant_credential` and `merchant_invitation` tables; no production route,
 * Server Action or merchant session reads or writes them yet. S1.2 adds
 * nullable ownership columns to the tenant-owned roots; the application
 * remains single-store and single-administrator until a separately approved
 * backfill and enforcement phase.
 *
 * Two independent recursive hierarchies live here and are never merged
 * (ADR-014): the catalog tree (`category.parentId`) and the interaction tree
 * (`productAction.parentActionId`). Triggers and indexes — not just
 * application code — make self-parenting, cycles, cross-product parents,
 * children under terminal nodes and duplicate sibling ordering impossible to
 * write. Those triggers are version-controlled SQL in `drizzle/`, because they
 * cannot be expressed in the TypeScript schema; see
 * `drizzle/0001_tree_and_snapshot_integrity.sql`.
 */

export * from "./actions";
export * from "./auth";
export * from "./catalog";
export * from "./content";
export * from "./customer";
export * from "./inquiry";
export * from "./payment-methods";
export * from "./seller-notifications";
export * from "./settings";
export * from "./telegram";
export * from "./telegram-connections";
export * from "./tenant";
