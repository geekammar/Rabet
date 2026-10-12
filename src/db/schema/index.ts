/**
 * The complete Drizzle schema for Rabet, grouped by the domains of
 * DATA_MODEL.md §2.
 *
 * Fourteen tables in seven domains — Configuration, Content, Catalog,
 * Buttons, People, Conversations, Integration — and no financial entity
 * anywhere (ADR-013). Import this barrel from the client and from tests; never
 * import an individual schema module, so a table cannot be silently left out
 * of the client's schema map (which is what makes `db.query.*` relation
 * helpers work).
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
export * from "./catalog";
export * from "./content";
export * from "./customer";
export * from "./inquiry";
export * from "./settings";
export * from "./telegram";
