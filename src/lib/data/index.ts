import "server-only";

/**
 * ===========================================================================
 * The server-only data access layer — public surface.
 * ===========================================================================
 *
 * Focused, typed functions over four of the fourteen tables: `bot_setting`,
 * `language`, `message_template` and `message_translation` (Phase 03C-A). The
 * catalog, button, customer, inquiry and Telegram tables are untouched and get
 * their own layers in later phases.
 *
 * Design rules this layer keeps (see `docs/ARCHITECTURE.md` §3.2 and
 * `docs/PROGRESS.md`, "Phase 03C-A"):
 *
 *   - **Server-only.** Every module here imports `server-only`, so none of it —
 *     and no database credential — can reach a client bundle. A Client
 *     Component must never import from here; a Server Component, Server Action
 *     or Route Handler imports from this barrel.
 *   - **One client, injected.** Every function takes the Drizzle client as its
 *     first argument. Production passes `getDb()`; tests pass a real
 *     PostgreSQL client. There is no module-level client creation and no
 *     module-level query, so importing this barrel never requires `DATABASE_URL`
 *     and a build cannot fail because a database is unconfigured (ADR-015).
 *   - **No generic repository framework.** Each function is one query with a
 *     documented purpose; shared behaviour is shared *constraints and error
 *     types*, not shared plumbing.
 *   - **Typed errors, safe messages.** Every failure is a `RabetDataError`; raw
 *     driver errors are mapped by SQLSTATE and never surfaced verbatim
 *     (`errors.ts`).
 *   - **Atomicity without interactive transactions.** Every write is
 *     idempotent at its own site (`ON CONFLICT …`), so the neon-http driver's
 *     `db.batch([...])` is not required by any path here; where a future path
 *     genuinely needs several writes to commit together, it will use
 *     `db.batch([...])` and never `db.transaction()` (ADR-015).
 *
 * Security boundary: every future Admin Server Action and Route Handler that
 * calls into this layer **must** call `requireAdmin()` (`src/lib/auth/session.ts`)
 * at its entry boundary (ADR-010). Nothing in this layer performs an
 * authorization check itself, by design — the layer is reachable only from
 * server code, and the caller is where the one trust decision belongs.
 */

export * from "./catalog";
export * from "./errors";
export * from "./languages";
export * from "./settings";
export * from "./templates";
