# Progress — Rabet (رابط)

Current phase: **Phase 10A — Establish the Verified Launch Baseline & Prepare the First MVP Cutover (in review)**
Project stage: **Discovery & Development** (not commercial production)

Related: [ARCHITECTURE.md](./ARCHITECTURE.md) for decisions,
[DATA_MODEL.md](./DATA_MODEL.md) for the approved database design,
[PHASE_04A_HANDOFF.md](./PHASE_04A_HANDOFF.md) for Store Settings & Onboarding UI handoff,
[PHASE_04B_HANDOFF.md](./PHASE_04B_HANDOFF.md) for Global Bot Content Editor handoff,
[PHASE_05A_HANDOFF.md](./PHASE_05A_HANDOFF.md) for Category & Product Editor handoff,
[PHASE_05B1_HANDOFF.md](./PHASE_05B1_HANDOFF.md) for First Recursive Product Action Editor handoff,
[PHASE_05B2_HANDOFF.md](./PHASE_05B2_HANDOFF.md) for Remaining Four Product Action Types handoff,
[PHASE_06A_HANDOFF.md](./PHASE_06A_HANDOFF.md) for Secure Telegram Webhook & First Catalog Journey handoff,
[PHASE_06B_HANDOFF.md](./PHASE_06B_HANDOFF.md) for Non-Conversation Product Action Runtime handoff,
[PHASE_07_HANDOFF.md](./PHASE_07_HANDOFF.md) for Unified Customer Inquiries, Support & Inbound Messages handoff,
[PHASE_09_HANDOFF.md](./PHASE_09_HANDOFF.md) for Seller Inbox, Reliable Replies & Lifecycle handoff,
[PHASE_10A_LAUNCH_READINESS.md](./PHASE_10A_LAUNCH_READINESS.md) for Launch Baseline & Cutover Preparation,
[NEON_DEV_SETUP.md](./NEON_DEV_SETUP.md) for the one-command development
database setup wizard.

> This file tracks the **Phase 02B** authentication pass, the **Phase 03A**
> data-model design pass, the **Phase 03B** database implementation, the
> **Phase 03C-A** data-access layer, the **Phase 04-A** Settings UI pass, the
> **Phase 04-B** Bot Content Editor pass, the **Phase 05-A** Catalog Editor pass,
> the **Phase 05-B1** Product Action Editor pass, the **Phase 05-B2** Action Types pass,
> the **Phase 06-A** Telegram Catalog Journey pass,
> the **Phase 06-B** Non-Conversation Product Action Runtime pass,
> the **Phase 07** Customer Inquiries & Inbound Messages pass,
> the **Phase 09** Seller Inbox, Reliable Replies & Conversation Lifecycle pass,
> and the **Phase 10A** Launch Readiness & Cutover Preparation pass.
> Phases 01, 02, 03A, 03B, 03B-B, 03B-C, 03C-A, 04-A, 04-B, 05-A, 05-B1, 05-B2, 06-A, 06-B, 07, and 09 are merged into `main`:
> Phase 04-A was merged into `main` via PR #10, Phase 04-B was merged into `main`
> via PR #12 (`fd91ccdb6802ac06cfdc041a570990547ef50a37`), Phase 05-A was merged into `main`
> via PR #13 (`b9c1883bd3f608d736d89cf31971c7d62f16d132`), Phase 05-B1 was merged into `main`
> via PR #14 (`c88430db2fb2b834d841cdbce85de64de0f35ae0`), Phase 05-B2 was merged into `main`
> via PR #15 (`ecee24546ce67795fc091a7392447dec88ad9a59`), Phase 06-A was merged into `main`
> via PR #16 (`0d4e2f1ae66217c5eb32c610ebd70318a4f3f67d`), Phase 06-B was merged into `main`
> via PR #17 (`571a2a1c0e9e33eafa4d9bcc96e2f4a65d4745e8`), Phase 07 was merged into `main`
> via PR #18 (`cd89238525d2f4ba24bdfec6dc2b6b92aea2ce26`), and Phase 09 was merged into `main`
> via PR #19 (`77fc463e088bb62224c396563c4831dd8aa21683`). Phase 10A is prepared and in review
> on `feat/phase-10a-launch-readiness`.
> Note that tree maintenance (reparenting, reordering, deletion) remains deferred from the launch-critical path, and launch hardening belongs to Phase 10.

---

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| **Phase 01** | Project foundation & UI shell | ✅ **Merged into `main`** |
| **Phase 02** | Admin authentication | ✅ **Merged into `main`** ([PR #5](https://github.com/geekammar/Rabet/pull/5), `f6a7738`) — code complete and Production-ready; the **manual interactive device checks and the durable rate limiter remain open** (see below), so Phase 02 is not marked *fully accepted* |
| **Phase 03A** | Data model & recursive button architecture **design** | ✅ **Merged into `main`** ([PR #4](https://github.com/geekammar/Rabet/pull/4), `269cf7c`) — documentation only |
| **Phase 03B** | Database schema, migrations & DB test foundation | ✅ **Merged into `main`** ([PR #6](https://github.com/geekammar/Rabet/pull/6)) — 14 tables, 2 migrations, server-only client, 53 DB tests; the dedicated Neon development database has the chain applied and inspected |
| **Phase 03B-B** | Neon development setup wizard (`npm run db:setup:dev`) | ✅ **Merged into `main`** ([PR #7](https://github.com/geekammar/Rabet/pull/7)) — one command for the first VPS and every replacement VPS; verified against real PostgreSQL, including the reconnect scenario |
| **Phase 03B-C** | Neon DEV GitHub Actions migration runner (`workflow_dispatch` only) | ✅ **Merged into `main`** ([PR #8](https://github.com/geekammar/Rabet/pull/8)) — manual inspect/migrate workflow on GitHub-hosted runners; a real DEV migration and a final read-only inspection have run successfully |
| **Phase 03C-A** | Server-only settings & localization data access | ✅ **Merged into `main`** ([PR #9](https://github.com/geekammar/Rabet/pull/9), `bead4ed`) — typed data-access layer for `bot_setting`, `language`, `message_template` and `message_translation`, with the explicit initialization contract |
| **Phase 04-A** | Store Settings & Onboarding UI | ✅ **Merged into `main`** ([PR #10](https://github.com/geekammar/Rabet/pull/10)) — mobile-first Settings page, welcoming first-time onboarding, existing settings edit mode, USD default selection with currency safeguards, English default with RTL Arabic enablement, editable support categories, and clean database availability state handling (States A, B, C, D) |
| **Phase 04-B** | Bot Content & message templates UI | ✅ **Merged into `main`** ([PR #12](https://github.com/geekammar/Rabet/pull/12), `fd91ccdb6802ac06cfdc041a570990547ef50a37`) — focused, usable global bot content editor for the 7 canonical templates (`bot_welcome`, `support_welcome`, `support_received`, `inquiry_received`, `conversation_resolved`, `option_unavailable`, `empty_menu`), pure non-recursive placeholder interpolation, explicit per-template/per-language saves, draft preservation, RTL Arabic editing, mobile 360px support, and 0 writes on load |
| **Phase 05-A** | First Usable Category & Product Editor | ✅ **Merged into `main`** ([PR #13](https://github.com/geekammar/Rabet/pull/13), `b9c1883bd3f608d736d89cf31971c7d62f16d132`) — first usable category & product slice: hierarchy tree with depth safeguard, inactive-ancestor visibility explanation, product creation/editing under non-deleted categories, exact decimal displayed price, atomic rollback persistence, truthful localization fallback, and mobile 360px support |
| **Phase 05-B1** | First Recursive Product Action Editor | ✅ **Merged into `main`** ([PR #14](https://github.com/geekammar/Rabet/pull/14), `c88430db2fb2b834d841cdbce85de64de0f35ae0`) — recursive product action configuration slice: 3 approved action types (`OPEN_SUBMENU`, `SHOW_DETAILS`, `START_INQUIRY`), same-product hierarchy enforcement, submenu-only parenting, atomic Neon HTTP batch persistence, runtime safeguards (`ACTION_DEPTH_WARNING_THRESHOLD=8`, `MAX_ACTION_DEPTH=16`, `MAX_ACTIVE_CHILDREN=20`, `MAX_ACTION_DEPTH_SAFEGUARD=64`), draft preservation across languages, 0 writes on load, and 360px responsive UI with >=44px targets |
| **Phase 05-B2** | Remaining Four Product Action Types | ✅ **Merged into `main`** ([PR #15](https://github.com/geekammar/Rabet/pull/15), `ecee24546ce67795fc091a7392447dec88ad9a59`) — configuration and persistence for all four remaining approved action types (`SEND_TEMPLATE_MESSAGE`, `OPEN_URL`, `OPEN_SUPPORT`, `NAVIGATE_CATALOG`), safe interpolation, atomic type transition rollback, draft preservation, and mobile 360px support |
| **Phase 05-B3** | Action Tree Maintenance | Not started (deferred from launch-critical path) — reparenting/moving actions, manual reordering, and action archiving/deletion |
| **Phase 06-A** | Secure Telegram Webhook & First Catalog Journey | ✅ **Merged into `main`** ([PR #16](https://github.com/geekammar/Rabet/pull/16), `0d4e2f1ae66217c5eb32c610ebd70318a4f3f67d`) — Node-runtime secure webhook route (`POST /api/telegram/webhook`), constant-time secret token validation, update deduplication on `telegram_update`, `/start` journey, language choice persistence, catalog hierarchy navigation, product card with exact decimal price, `OPEN_SUBMENU`, `SHOW_DETAILS`, Back/Home navigation, deterministic pagination, and truthful fallback for deferred runtime actions |
| **Phase 06-B** | Complete Non-Conversation Product Action Runtime | ✅ **Merged into `main`** ([PR #17](https://github.com/geekammar/Rabet/pull/17), `571a2a1c0e9e33eafa4d9bcc96e2f4a65d4745e8`) — Runtime execution for `SEND_TEMPLATE_MESSAGE` (real placeholder context, sequential chunk preservation, navigation on final chunk), `OPEN_URL` (intermediate tap check, WHATWG HTTPS validation, dedicated URL button without callback_data), `NAVIGATE_CATALOG` (hierarchy and ancestry checks, destination category page 1 / product card rendering with single acknowledgement), and deferred `START_INQUIRY` / `OPEN_SUPPORT` safeguards |
| **Phase 07** | Unified Customer Inquiries, Support & Inbound Messages | ✅ **Merged into `main`** ([PR #18](https://github.com/geekammar/Rabet/pull/18), `cd89238525d2f4ba24bdfec6dc2b6b92aea2ce26`) — Customer side complete: `START_INQUIRY` (creates/resumes active product inquiry with frozen localized snapshot and option ancestry), `OPEN_SUPPORT` (creates/resumes general or category support), inbound text message routing (`/start`, `/reply <REF> <msg>`, single active routing, multiple active disambiguation, 0 active auto-general-support), durable receipts bound to `telegram_update.payload.receipt`, atomic serialization, and retry idempotency |
| **Phase 08** | Payment integration (**deferred** — Telegram Stars, future) | Deferred — see ADR-013 |
| **Phase 09** | Complete the Seller Inbox, Reliable Replies & Conversation Lifecycle | ✅ **Merged into `main`** ([PR #19](https://github.com/geekammar/Rabet/pull/19), `77fc463e088bb62224c396563c4831dd8aa21683`) — Seller side complete: unified inbox (`/inquiries`) with status & type filters and exact reference search, thread view (`/inquiries/[id]`) with frozen product context & message history, durable plain-text seller replies with prefix `[INQ-XXXXXX]\n\n`, atomic Neon batch reservation, deduplicated transport delivery via stable operation UUID, explicit retry of failed/stale deliveries, honest diagnostics, and strict conversation lifecycle transitions (`open`, `waiting_on_customer`, `resolved`, `closed`, `reopen` with active duplicate conflict checks). Live production acceptance and physical device verification pending Phase 10. |
| **Phase 10** | Testing, security & release hardening | 🟦 **Phase 10A in review** ([docs/PHASE_10A_LAUNCH_READINESS.md](./PHASE_10A_LAUNCH_READINESS.md)) — Verified baseline established, evidence-backed readiness matrix, launch blockers identified (Vercel edge SSO interception, production DB unprovisioned, login rate limiting), cutover runbook and physical Android acceptance checklist documented. Live production cutover and physical device acceptance pending Phase 10B. |

The base Vercel deployment and the GitHub integration were configured during
Phase 01, but release hardening (Phase 10) is **not** complete.

### What "Phase 02 merged" means, precisely

To avoid overstating: PR #3 merged and Vercel Production is **Ready** for the merged
commit, so Phase 02 is delivered. The following were **not** completed by the merge and
stay separately tracked:

- The **manual interactive authentication checks** (the checklist under "Remaining manual
  verification" below). The development VPS has no browser; the integration suite proves
  the HTTP/server-side behaviour, but the interactive UI checks need a real browser
  against a provisioned deployment.
- The **durable rate limiter** (ADR-011). Until it is in place, Vercel Deployment
  Protection should stay enabled and the app is not brute-force hardened for an
  internet-facing deployment.
- Central **session revocation** (ADR-009) — still stateless JWT sessions; revisited as an
  open decision now that a database is being designed (DATA_MODEL.md §12.2).

## What was done in Phase 03A

A **design-only** pass — the deliverable is a reviewed document, not code.

### The scope correction (product-owner review on PR #4)

Phase 03A started with a fourteen-table model built around orders and payments. Five
clarifications from the product owner on [PR #4](https://github.com/geekammar/Rabet/pull/4)
converged on a simpler product, and the design was **rewritten around it** rather than
patched:

1. **Simplify payment management** — no payment gateway, no Binance/Vodafone API, no
   financial webhooks, no auto-settlement; a manual external-payment workflow at most.
2. **Complete the request flow inside Telegram** — browse, select, create/track a request,
   and message the seller; Rabet manages communication, not money.
3. **Final correction — inquiries, not orders** — "Buy" starts a **conversation** tied to
   the catalog item and its displayed price. **No payment, payment link, proof, charge,
   invoice or checkout exists in Rabet at this stage.**
4. **Configurable multi-action buttons** — each catalog item may have multiple ordered,
   enabled/disabled buttons with localized labels and a safe, finite action allowlist.
5. **Recursive multi-level button trees** — buttons can open further buttons, recursively,
   with the admin choosing label and behaviour at **every node**. Catalog navigation and
   interaction-button navigation are **separate hierarchies**.

The resulting design is in [DATA_MODEL.md](./DATA_MODEL.md); the scope decisions are
recorded as **ADR-013** (catalog + inquiries, not a checkout — including the Telegram Stars
compliance guardrail) and **ADR-014** (two independent recursive hierarchies) in
[ARCHITECTURE.md](./ARCHITECTURE.md).

#### Final design corrections (architecture review of 2026-10-12)

A follow-up review of the 1,560-line design identified four corrections that this pass
applied, **documentation only**, on the same PR:

1. **Navigation callbacks were context-free.** The reserved `back` / `product` / `page:<n>`
   tokens carried no product, menu or message identity, so with several products or menus open
   the backend could not infer what they referred to — yet the design claimed navigation needed
   no state. **Fixed:** tokens are now **self-scoping** (§8.1) — `b:<actionUuid>`,
   `m:<actionUuid>:<n>`, `p:<productUuid>` carry their own anchor, all under 64 bytes, with
   stale-anchor handling documented. Navigation genuinely needs zero session state now.
2. **The transaction approach was assumed, not verified.** §15.3 chose `neon-http` while the
   design's atomic writes needed multi-step transactions. **Verified against the Drizzle driver
   source:** `db.transaction()` throws on `neon-http`; `db.batch([...])` is the supported
   non-interactive batched transaction. §15.3 now documents one tested approach and reshapes
   every write path to fit it, with `neon-serverless` as the documented escape hatch.
3. **Depth promises contradicted the UX.** The schema promised arbitrary depth while the UI
   warned at 8 and stopped at 16. §11.3 now separates the two explicitly: **unlimited schema
   nesting, guarded UI and runtime** — the guards are operational safeguards raisable by a
   one-line code change, not product limits. §19.4 records the decision for owner acceptance.
4. **Hidden localization and currency assumptions.** Support categories were English-only
   despite the optional Arabic bot, and the single display currency was an unstated default.
   Both are now recorded as explicit MVP decisions with recommended defaults (§19.1, §19.6),
   along with empty-menu behaviour (§19.2), inquiry reopening (§19.3) and message retention
   (§19.5).

Two smaller guardrails were also applied: preview database branches are documented as
**schema-only — real customer data is never copied into them** (§15.4), and the Neon region is
described accurately as *close to* rather than *the same as* Vercel's `iad1`.

### What the revised design delivers

- **Simplified entity model.** Fourteen tables in seven domains — Configuration, Content,
  Catalog, Buttons, People, Conversations, Integration — down from a commerce-centric model
  by removing the **entire financial subsystem** (`order`, `order_item`, `order_event`,
  `payment`) and **unifying support tickets into the inquiry model**
  (`support_ticket` / `support_message` are gone).
- **Two independent recursive hierarchies.** The **catalog tree** (`category`,
  adjacency-list `parent_id`) organizes products; the **interaction-button tree**
  (`product_action`, adjacency-list `parent_action_id`) controls customer interaction. Both
  are arbitrary-depth with **no schema depth cap** — bounded only by documented application
  runtime guards (`MAX_ACTION_DEPTH` 8, `MAX_ACTIVE_CHILDREN` 20, `MENU_PAGE_SIZE` 10).
- **Configurable button actions.** A closed, safe allowlist of seven `action_type` values —
  `OPEN_SUBMENU`, `START_INQUIRY`, `SHOW_DETAILS`, `SEND_TEMPLATE_MESSAGE`, `OPEN_URL`,
  `OPEN_SUPPORT`, `NAVIGATE_CATALOG`. An `OPEN_SUBMENU` may first send an editable
  localized message and then show its children, which delivers "message + more options"
  **without a workflow engine**. Only `OPEN_SUBMENU` may have children — enforced by
  trigger, not convention.
- **Tree integrity at the database level.** Triggers and indexes make self-parenting,
  cycles, **cross-product parent references**, children under terminal nodes and duplicate
  sibling ordering **impossible to write**.
- **Unified inquiry system.** One `inquiry` table serves product inquiries and general
  support; the displayed price and the customer's selected button path are **frozen at
  creation** (`product_snapshot`, `selected_options`, write-once), so later catalog edits
  never rewrite a conversation. At most one active inquiry per customer per product —
  `START_INQUIRY` is resume-by-construction.
- **Telegram navigation contract.** Self-scoping `callback_data` tokens, all well under the
  64-byte Bot API limit: an action's uuid (36 B) for action buttons, and `b:` / `m:` / `p:`
  prefixed tokens that carry the action, menu node or product they refer to, so Back,
  Return-to-product and pagination are unambiguous even with several products or old messages
  open. One button per row; pagination; graceful empty-submenu handling; documented
  stale-keyboard behaviour; prompt callback answers; idempotent state changes.
- **Minimal durable state.** Submenu navigation needs **zero session state** — every token names
  its own anchor, so no "current menu" is ever inferred — which fits Vercel serverless. The
  selected path is recovered from the action's own ancestor chain at inquiry time.
- **Localization.** One mechanism reused across categories, products, buttons and
  templates: one row per language with an English-first fallback chain; Arabic renders RTL.
  (Support categories themselves stay English-only `text[]` at the MVP — §19.1 of
  DATA_MODEL.md.)
- **Atomic writes without interactive transactions.** Verified against the Drizzle driver
  source: `neon-http` has **no** `db.transaction()` (it throws), so every atomic write path is
  shaped as a `db.batch([...])` — a non-interactive batched transaction — with per-site
  idempotency carrying the correctness load. `neon-serverless` (WebSocket) is the documented
  escape hatch, not the default.
- **Infrastructure & migration plan retained.** **Neon** managed PostgreSQL, Free plan,
  `aws-us-east-2` (the closest Neon region to Vercel's `iad1`, though not the same region),
  via the Neon-managed Vercel integration; Drizzle ORM + Kit with generated, committed,
  human-reviewed SQL; production migrations by hand against the unpooled connection;
  `drizzle-kit push` never used; preview branches schema-only — real customer data is never
  copied into them.

### What Phase 03A deliberately did not do

- No `src/db/` code, no `drizzle.config.ts`, no `drizzle/` migrations.
- No new npm dependency installed (`drizzle-orm`, `drizzle-kit`,
  `@neondatabase/serverless` are Phase 03B).
- No Neon project or database created, no connection made, no migration applied.
- No Telegram handlers, no Button Tree Editor, no bot runtime — those are Phases 05–09.
- No changes to application code, no version bump, and no deployment.

The manual Phase 02 checks below are unchanged and were **not** claimed as passing.

## What was done in Phase 03B

The approved Phase 03A design implemented as real, tested database code. Full
details in [PHASE_03B_HANDOFF.md](./PHASE_03B_HANDOFF.md); this is the summary.

### Delivered

- **Drizzle schema** — `src/db/schema/`, seven modules, fourteen tables in the
  seven approved domains, barrel-re-exported by `index.ts`:
  - **Configuration** — `bot_setting` (singleton, `CHECK (id = 1)`, currency
    allowlist `SAR/USD/AED/EGP`), `language` (`char(2)` unique code, `ltr`/`rtl`).
  - **Content** — `message_template` (stable `key`), `message_translation` (one
    row per template per language, 4096-char cap).
  - **Catalog (Tree 1)** — `category` adjacency list (`parent_id`, no depth
    cap), `category_translation`, `product` (displayed `numeric(18,2)` price,
    non-negative), `product_translation`.
  - **Buttons (Tree 2)** — `product_action` adjacency list
    (`parent_action_id`), the 7-value `action_type` allowlist, HTTPS-only `url`
    CHECK, mutually-exclusive navigation targets, `product_action_translation`
    (64-char label cap).
  - **People** — `customer` (Telegram `bigint` id unique, minimal attributes,
    anonymization-ready).
  - **Conversations** — `inquiry` (frozen `product_snapshot` /
    `selected_options`, one-active-per-customer-per-product partial unique
    index), `inquiry_message` (append-only, `UNIQUE (inquiry_id,
    telegram_message_id)` dedup).
  - **Integration** — `telegram_update` (`update_id` unique — the idempotency
    lock).
- **Migrations** — `drizzle/0000_initial_schema.sql` (all 14 tables, 4 enums,
  19 FKs, every index including the five partial unique indexes) and
  `drizzle/0001_tree_and_snapshot_integrity.sql` (idempotent trigger SQL for the
  rules TypeScript cannot express: `touch_updated_at` on 11 tables,
  `category_check_ancestry`, `product_action_check_ancestry`,
  `product_action_guard_menu_capability`, `inquiry_freeze_context`), plus the
  journal and snapshots in `drizzle/meta/`.
- **Client** — `src/db/client.ts`: `drizzle-orm/neon-http` over Neon's pooled
  HTTP endpoint (ADR-015), lazy `getDb()`, credential-free failure messages,
  `server-only`. Atomic multi-step writes are shaped as `db.batch([...])`
  because `db.transaction()` throws on this driver — verified against the driver
  source and asserted in the test suite.
- **DB test foundation** — `tests/db/` (5 suites, 53 tests) running against real
  PostgreSQL via a disposable cluster (`scripts/db-test-postgres.mjs`), one
  throwaway database per test file, `DATABASE_URL` deliberately never read.
- **CI** — a second GitHub Actions job (`db`) provides an isolated PostgreSQL
  service container, applies the migration chain, runs `db:check` for
  schema/migration drift, and runs the DB suites via `RABET_TEST_PG_URL`.

### Verification (all on the feature branch, against disposable clusters only)

| Command | Result |
| --- | --- |
| `npm run lint` | ✅ exit 0 |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 (with a test-only generated `AUTH_SECRET`) |
| `npm run test` (no cluster) | ✅ **131 tests** — 84 passed, 47 skipped (the DB suites), 11 files |
| `npm run test` (cluster designated) | ✅ **131 tests passed**, 0 skipped, 11 files |
| `npm run test:db` | ✅ **53 DB tests passed** (5 files) |
| `npx drizzle-kit check` | ✅ "Everything's fine" against a freshly migrated throwaway DB |
| `drizzle-kit generate` diff | ✅ SQL byte-identical to the committed chain |

### What Phase 03B deliberately did not do

- **No production database** — no Neon project created, no `DATABASE_URL` set in
  any environment, no migration run anywhere but a disposable cluster. This is
  intentional and remains true; provisioning is a manual owner action with a
  documented runbook.
- **No write-path layer** — repository functions (`db.batch([...])` with
  per-site idempotency) are the next phase; the schema is ready for them.
- **No seed data** — Phase 03B inserts no production business defaults
  (`bot_setting`, `language`, `message_template` rows are data, not schema).
- **No Telegram handlers, no Button Tree Editor, no bot runtime** — Phases 05–09.
- **No payment, order or invoice entity** anywhere (ADR-013).
- No version bump and no deployment.

## What was done in Phase 03C-A

The first slice of the write-path layer: a small, typed, **server-only** data
access layer for the four configuration and content tables — `bot_setting`,
`language`, `message_template`, `message_translation`. No dashboard UI, no
Telegram handlers, no catalog or inquiry operations; just the functions Phase 04
will call, with their rules proven against real PostgreSQL.

### Delivered

`src/lib/data/` — five modules, each importing `server-only`, each function
taking the Drizzle client as an injectable parameter (production passes
`getDb()`, tests pass a real PostgreSQL client):

| Module | Surface |
| --- | --- |
| `errors.ts` | `RabetDataError` with a closed `DataErrorCode` set; `mapDatabaseError()` maps PostgreSQL by SQLSTATE class (walking Drizzle's `DrizzleQueryError` wrapper to the driver error underneath); `invalidInput()` converts Zod failures; `toSafeErrorMessage()` collapses *anything* unknown into one fixed, credential-free sentence. No raw driver error — whose message can carry the failed SQL and parameters — is ever surfaced. |
| `settings.ts` | `readSettings`, `isConfigured`, `requireSettings`, `initializeSettings`, `updateSettings`; the `CURRENCIES` allowlist mirrored from the schema's `CHECK`; Zod schemas for both paths. |
| `languages.ts` | `listLanguages`, `listEnabledLanguages`, `readLanguage`, `requireLanguage`, `ensureLanguage` (the prerequisite helper), `setLanguageEnabled`, `resolveDefaultLanguage`, `requireDefaultLanguage`. |
| `templates.ts` | `readTemplate`, `requireTemplate`, `listTemplates`, `readTranslations`, `createTemplate`, `updateTemplate`, `saveTranslation`, and `resolveMessageText` — the DATA_MODEL.md §7 fallback chain returning an explicit `missing` result rather than a fabricated string. |
| `index.ts` | The barrel and the layer's contract: server-only, one injected client, no generic repository, typed errors, and the requirement that every future Admin Server Action and Route Handler call `requireAdmin()` at its entry boundary (ADR-010). |

### Business rules implemented (and tested)

- **The singleton.** `bot_setting.id = 1` is enforced by the primary key *and*
  `CHECK (id = 1)`; initialization inserts exactly that row.
- **Explicit initialization.** Display name, currency and default language code
  have **no** defaults in code or schema — nothing invents a business currency
  or a bot name on the owner's behalf. `askForLanguage` and `supportCategory`
  carry only non-business defaults (a boolean and an empty array).
- **Duplicate initialization is an error**, not a silent update:
  `SETTINGS_ALREADY_INITIALIZED`, and the existing row is left byte-identical.
- **The default-language relationship.** Initialization and update both require
  a language row that **exists and is enabled** (`LANGUAGE_NOT_FOUND` /
  `LANGUAGE_NOT_ENABLED`) — the rule a `CHECK` cannot express (DATA_MODEL.md
  §12.5).
- **English is the primary/default language; Arabic is optional and RTL.**
  `text_direction` is validated in code and constrained in the database.
- **Disabling a language preserves its translations** — nothing is deleted;
  `listEnabledLanguages` simply stops offering it.
- **The active default language cannot be disabled** without first choosing
  another valid default: `DEFAULT_LANGUAGE_REQUIRED`, and the row stays enabled.
- **One row per template per language** — upsert on the unique index
  `message_translation_template_language_idx`; repeated saves replace the body.
- **Stable template keys.** Lowercase snake_case, validated before any query;
  a key is never renamed, and re-creating a key never clobbers its content.
- **The 4096-character cap** on message bodies is enforced by Zod before any
  query *and* by the database's own `CHECK`.
- **The fallback chain resolves in order** — requested language, then the
  configured default, then an explicit `missing` result with a reason
  (`template_missing` / `no_default_language` / `translation_missing`). No
  business content is ever fabricated.
- **Idempotency everywhere.** Every write is a single statement idempotent at
  its own site (`ON CONFLICT DO NOTHING` / `DO UPDATE`), so no path needs an
  interactive transaction and none uses one (ADR-015).

### Verification (all on the feature branch, disposable PostgreSQL only)

| Command | Result |
| --- | --- |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 — with `DATABASE_URL` **unset**; no data-layer or database module reaches any client bundle (scan of `.next/static`) |
| `npm run test` (cluster designated) | ✅ **369 tests passed**, 24 files, 0 skipped |
| `npm run test` (no cluster) | ✅ the DB suites skip cleanly and never fail |
| `npm run test:db` | ✅ disposable cluster → `tests/db` → cluster deleted |
| `npx drizzle-kit check` | ✅ "Everything's fine" — no schema/migration drift (no schema or migration file was touched) |

### New test coverage (94 tests)

| File | Tests | Covers |
| --- | --- | --- |
| `src/lib/data/__tests__/errors.test.ts` | 17 | every SQLSTATE class maps to the right code; the wrapped `DrizzleQueryError` path; the original error survives on `cause`; connection strings and passwords never reach a safe message |
| `src/lib/data/__tests__/validation.test.ts` | 17 | the Zod schemas: currency allowlist, display name, language code and direction, template key shape and length, the 4096-character body cap, and that initialization requires its identity values |
| `src/lib/data/__tests__/driver-contract.test.ts` | 2 | the neon-http client exposes `db.batch()` and the integration client does not — the honest boundary on what the DB suites can exercise |
| `tests/db/settings.test.ts` | 18 | empty state; explicit initialization; duplicate initialization; the singleton and currency `CHECK`s as real SQL; default-language validation; partial updates; idempotent repeats |
| `tests/db/languages.test.ts` | 17 | registration and idempotent re-runs; listing enabled vs all; enabling/disabling; translations survive disabling; `DEFAULT_LANGUAGE_REQUIRED`; the direction `CHECK` as real SQL |
| `tests/db/templates.test.ts` | 23 | template CRUD with stable keys; translation upsert; the one-row-per-language index and the 4096 `CHECK` as real SQL; every branch of the fallback chain |

### The initialization contract (replaces the open seed-data decision)

Phase 03B left "seed migration vs dashboard-first flow" as an open decision
(its §14 item 4). Phase 03C-A resolves it in favour of an **explicit, code-level
contract** — no seed migration, no automatic write to any database, and a future
Phase 04 onboarding form that calls the approved flow. The contract:

1. **Language prerequisites first.** A `language` row for the default language —
   `en`, enabled — must exist before settings can be initialized. It is created
   by `ensureLanguage({ code: "en", label: "English", textDirection: "ltr",
   isEnabled: true })`, which is idempotent and **never overwrites** an existing
   row, so re-running setup after the seller has edited anything changes
   nothing. Arabic, when the seller wants it, is `ensureLanguage({ code: "ar",
   label: "العربية", textDirection: "rtl" })` plus
   `setLanguageEnabled({ code: "ar", isEnabled: true })`.
2. **Values the owner must provide explicitly:** `displayName`, `currency` (one
   of `SAR`/`USD`/`AED`/`EGP`) and `defaultLanguageCode`. `askForLanguage`,
   `supportCategory` and `supportReplyTime` are optional and start from neutral
   defaults.
3. **When settings already exist:** `initializeSettings` throws
   `SETTINGS_ALREADY_INITIALIZED` and changes nothing. The owner edits the
   existing row through `updateSettings` instead.
4. **When setup is interrupted:** nothing to repair. Each step is independently
   idempotent — the language insert and the settings insert can both be retried
   in any order, and a partial state is simply continued, not rolled back or
   duplicated.
5. **How duplication is prevented:** the settings singleton's primary key plus
   `CHECK (id = 1)` at the database level, `ON CONFLICT DO NOTHING` at the
   application level, and the typed error that reports the conflict.
6. **What is still not decided:** which currency the seller uses. `SAR` is the
   documented *recommendation* awaiting owner confirmation (DATA_MODEL.md
   §19.6); the layer accepts any allowlisted member and inserts nothing on its
   own. No template keys are created either — Phase 04 decides which strings the
   bot needs and calls `createTemplate` for each.

**No data was seeded into `Rabet_dev` or any other database by this phase.**
The contract is code and documentation; the first invocation is a Phase 04 owner
action.

### What Phase 03C-A deliberately did not do

- **No UI** — the dashboard `/settings` and `/bot-content` routes are unchanged
  and still render their existing placeholders; no route queries the database at
  render or build time.
- **No new tables, no schema change, no migration** — `src/db/schema/` and
  `drizzle/` are untouched (verified by `drizzle-kit check`).
- **No catalog, product, inquiry, customer or Telegram write paths** — later
  phases; the data-access pattern this phase establishes is the one they will
  follow.
- **No payment functionality** anywhere (ADR-013).
- **No new npm dependency** — existing Drizzle and Zod only.
- **No `db.batch([...])` call** — no path here needs several writes to commit
  together; each write is one idempotent statement. The batch API is verified at
  the driver level only (`driver-contract.test.ts`), which is documented as
  such. The first path that genuinely needs atomicity will use it.
- No version bump and no deployment.

### Exact prerequisites for Phase 04

Phase 04 (the settings & localization **UI**) can safely consume, with no further
backend work:

- `isConfigured(getDb())` to decide between the onboarding form and the settings
  editor on `/settings`;
- `ensureLanguage` → `initializeSettings` for the onboarding form, and
  `updateSettings` for every subsequent edit;
- `listLanguages` / `listEnabledLanguages` for the language tabs and toggles, and
  `setLanguageEnabled` with its `DEFAULT_LANGUAGE_REQUIRED` error surfaced as a
  form message;
- `createTemplate` / `updateTemplate` / `readTranslations` /
  `saveTranslation` for the `/bot-content` template editor, with
  `readTranslations` giving one round trip per open template;
- `resolveMessageText` for any future preview surface — it never fabricates a
  string, so the UI must render the `missing` case honestly;
- `RabetDataError.code` for field-level form messaging, and
  `toSafeErrorMessage()` as the single funnel for anything unexpected.

The one hard rule for Phase 04: **every Server Action and Route Handler that
calls into this layer must call `requireAdmin()` first** (ADR-010). The layer
performs no authorization itself, by design.

## What was done in Phase 04-A

Phase 04-A replaces the `/settings` dashboard placeholder with a real, mobile-first
administrator interface backed by the approved Phase 03C-A data-access layer.

### Delivered

1. **Settings Page with Four Database Availability States (`src/app/(dashboard)/settings/page.tsx`)**:
   - **State A (`DATABASE_URL` not configured)**: Renders a clean "Database setup required"
     administrator notice card without throwing or failing builds.
   - **State B (DB unavailable / transient failure)**: Catches connection errors and renders
     a safe, recoverable error state with a retry action and zero credential leakage.
   - **State C (DB available, uninitialized)**: Renders the first-time store onboarding form.
   - **State D (DB available, configured)**: Renders the editable store settings form and
     the localization management card.

2. **First-Time Store Onboarding (`OnboardingForm`)**:
   - Welcoming first-time setup interface.
   - Required fields: Store display name, display currency (pre-selecting **USD** with SAR, AED, EGP options), default bot language (English `en`).
   - Optional fields: Ask customer for language prompt on launch, support categories, support reply-time description.
   - Explicit initialization only via `initializeStoreSettings`: calls `ensureLanguage` for English, rejects duplicate initialization safely with `SETTINGS_ALREADY_INITIALIZED`, and never seeds fake business defaults.

3. **Existing Settings Edit Mode (`SettingsEditForm`)**:
   - Allows updating display name, display currency, default language, ask-for-language prompt, support categories, and reply-time description.
   - Submits via `updateStoreSettings` Server Action with server-side validation and immediate revalidation.
   - Preserves form state and provides clear success and error feedback.

4. **Currency Change Safety (`CurrencyPicker`)**:
   - USD is the approved initial selection.
   - Explains clearly: *"Changing currency does not convert existing product prices."*
   - When active catalog products are present (`hasCatalogPrices(db) === true`), changing currency requires explicit checkbox confirmation (`confirmCurrencyChange`).
   - Does not rewrite product prices and leaves inquiry price snapshots intact.

5. **Language Settings (`LanguageSettingsCard`)**:
   - English (`en`, LTR) is initially selected.
   - Arabic (`ar`, RTL) can be enabled or disabled on demand via `toggleLanguageAction`.
   - Prevents disabling the active default language (`DEFAULT_LANGUAGE_REQUIRED`).
   - Disabling a language preserves all existing translations.
   - Explains that missing requested translations fall back to the configured default language, and if neither translation exists, the result is explicitly missing.

6. **Support Configuration (`SupportCategoryManager`)**:
   - Interactive mobile-first component for `bot_setting.support_category` (`text[]`).
   - Allows adding, editing, removing, and reordering categories.
   - Provides suggested example chips (*General Question*, *Product Support*) as clickable additions without silent database seeding.
   - An empty category list remains valid and can be explicitly cleared.

7. **Server Actions Security Boundary & Form Contracts (`src/app/actions/settings.ts`)**:
   - Every action asserts `await requireAdmin()` at entry before reading or writing data (ADR-010).
   - Checkbox false persistence: uses a hidden input + checkbox contract parsed accurately so unchecked boxes persist `false` without clobbering partial updates.
   - Blank store names: rejects empty or whitespace-only display names with validation errors, leaving stored settings unchanged.
   - Explicit initialization values: requires `displayName`, `currency`, and `defaultLanguageCode` in the server request; fully validates all fields before any DB write; duplicate initialization preserves existing configuration.
   - Neighboring form fields: distinguishes omitted fields (`undefined`) from explicitly cleared ones (such as empty categories `[]` or null reply times) during partial updates.
   - Uses `toSafeErrorMessage()` to collapse any unexpected driver error into a fixed safe string.

### Isolated Testing Requirements for Development & Preview Runtimes

- **Local VPS / Dev**: Run `npm run db:setup:dev` to connect and migrate an isolated Neon development branch (`Rabet_dev`).
- **Preview Deployments**: Set `DATABASE_URL` in the Vercel project environment settings targeting an isolated branch/preview database.
- **Production Safety**: No Production database was provisioned or connected during this phase.

### Phase 04-B Message Template Plan (Reserved for 04-B)

The `/bot-content` editor in Phase 04-B will manage the seven canonical message templates:
1. `bot_welcome` — Main greeting when customer opens the bot
2. `support_welcome` — Introduction displayed upon opening support
3. `support_received` — Confirmation sent when customer submits a support inquiry
4. `inquiry_received` — Confirmation sent when customer requests a product
5. `conversation_resolved` — Message sent when seller resolves a conversation
6. `option_unavailable` — Notice displayed if a selected option is disabled
7. `empty_menu` — Fallback when a category or menu currently has no active items

These templates remain unseeded and their editor will be implemented in Phase 04-B.

## What is done in Phase 01

### Foundation

- Next.js 16 App Router project initialised in the repository root with
  TypeScript in **strict mode**.
- Tailwind CSS v4 with a neutral design-token system (light + dark token sets).
- ESLint configured with `eslint-config-next` (flat config) and passing.
- `src/` directory with the `@/*` → `./src/*` import alias.
- `npm` as the package manager; `package-lock.json` committed.

### UI shell

- Public **landing page** at `/` (hero, feature overview, footer).
- **Dashboard shell** in the `(dashboard)` route group:
  - responsive sidebar (desktop) and slide-in drawer (mobile) sharing one
    navigation definition in `src/lib/navigation.ts`;
  - sticky header with a "Phase 1 · Preview" badge;
  - skip-to-content link, `aria-current="page"` on the active link, and a
    Radix-based drawer that manages focus and Escape-to-close;
  - constrained content width so the layout never overflows.
- **Overview page** with clearly labelled empty state and quick-links to every
  section — no invented statistics or revenue figures.
- **Placeholder pages** for Services, Orders, Customers, Payments, Bot Content,
  Telegram and Settings, each with a consistent, section-specific empty state.
- Reusable **`PageHeader`** and **`EmptyState`** components.
- Loading (`loading.tsx` skeleton), error (`error.tsx` boundary) and
  `not-found.tsx` patterns wired into the dashboard group.

### Tooling & documentation

- `npm run dev`, `npm run lint`, `npm run build`, `npm run typecheck` all work.
- GitHub Actions workflow runs install → lint → typecheck → build with no
  external secrets.
- `README.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`, `.env.example` and
  `.gitignore` written.

### Phase 01B — final review and documentation alignment

- The roadmap in every document was realigned to the approved ten-phase order
  (foundation → authentication → database → settings → services → Telegram →
  customers/orders → payments → operations → hardening).
- The development workflow (Mobile → VPS → GitHub → Vercel) and the preferred
  Git workflow (branch → PR → CI → Vercel preview → review → merge) were
  recorded in `README.md` and `docs/ARCHITECTURE.md`.
- Payment documentation was corrected: it no longer claims no other provider
  will ever be integrated. Telegram Stars remain the required method for
  digital goods inside Telegram; Binance personal payment links are noted as
  under evaluation for separately permitted contexts only, expiring by nature,
  and not implemented now.
- The root 404 page was given a `<main>` landmark so it matches the landmark
  structure of every other page.
- The base Vercel deployment is recorded as configured; release hardening stays
  incomplete and assigned to Phase 10.

### Phase 01C — Mobile-first UX & PWA foundation

**Mobile-first UX (Part A).** The existing visual identity is unchanged; the
shell was hardened for small touch screens:

- Every dashboard navigation link (desktop sidebar **and** mobile drawer) now
  has a `min-h-11` (44 × 44 CSS px) touch target, the mobile drawer trigger and
  drawer close button were raised to 44 px, and the landing-page CTAs, 404 and
  error-boundary buttons were raised to 44 px as well.
- The active navigation item gained a small accent bar alongside the existing
  background highlight, and its icon switches to the accent foreground colour,
  so the current section reads at a glance on a small screen.
- Display cut-out support: `viewport-fit=cover` plus `env(safe-area-inset-*)`
  padding on the sticky header, the sidebar, the mobile drawer and page
  bottoms, so standalone mode on a notched phone never hides chrome under the
  status bar or home indicator.
- The root layout switched from `min-h-full` to `min-h-dvh` so the on-screen
  browser chrome cannot push content out of view.
- The mobile drawer width is now `min(18rem, 100dvw - 1.5rem)`, so it can never
  overflow a ~280–320 px viewport.
- Focus rings were added to the plain text links that previously had none
  (header wordmark, sidebar logo, landing footer link), and the nav link ring
  gained an offset so it stays visible against the sidebar surface.
- Mobile tap highlight is disabled and vertical overscroll is suppressed so
  standalone usage feels native instead of flashing grey on every tap.

**PWA foundation (Part B).** Following the current Next.js App Router guidance:

- `src/app/manifest.ts` generates `/manifest.webmanifest` — `display:
  standalone`, `start_url: /overview`, `scope: /`, light `theme_color` and
  `background_color`, and `any` + `maskable` icons at 192 px and 512 px. Next.js
  auto-injects the `<link rel="manifest">`.
- Real, brand-faithful icons were generated into `public/icons/` from the
  existing brand mark (the lucide `Link2` glyph in the `primary` /
  `primary-foreground` design tokens, converted from OKLCH to sRGB):
  `icon-192x192.png`, `icon-512x512.png`, `maskable-192x192.png`,
  `maskable-512x512.png` (glyph kept inside the 80 % maskable safe zone) and a
  180 × 180 `apple-touch-icon.png` referenced through `metadata.icons.apple`.
- `src/app/favicon.ico` was replaced with the same brand mark (16/32/48 px).
- `metadata` gained `applicationName` and `appleWebApp` (capable, title,
  default status-bar style); the new `viewport` export carries `themeColor`.
- `scripts/generate-pwa-icons.py` is the stdlib-only generator for all of the
  above, so the assets stay reproducible from the brand tokens.

## What is done in Phase 02A

### Authentication

- **Auth.js v5** (`next-auth@5.0.0-beta.32`) configured in `src/auth.ts` with the
  Credentials provider and the database-free encrypted-JWT session strategy
  (7-day `maxAge`, custom `/login` pages). See ADR-009 in
  [ARCHITECTURE.md](./ARCHITECTURE.md).
- **One administrator**, declared by the `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`
  environment variables. No registration, no other accounts, no roles.
- **Argon2id password hashing** via `@node-rs/argon2` (OWASP-recommended cost
  parameters). Plain SHA-256 is never used. The plaintext password is never
  stored, logged or compared in the clear; a failed attempt returns `null` for
  every failure mode so the admin email cannot be enumerated.
- **Fail-closed configuration** (`src/lib/auth/admin-config.ts`): a missing,
  empty or non-Argon2 `ADMIN_PASSWORD_HASH` disables sign-in entirely. There is
  no default account and no bypass. The login page renders an honest
  "sign-in unavailable" state when the deployment is not provisioned.
- **Layered authorization** (ADR-010): an optimistic redirect in `src/proxy.ts`
  (the Next.js 16 rename of `middleware.ts`) plus the authoritative
  `requireAdmin()` server-only helper used by the `(dashboard)` layout, the
  login/logout Server Actions and the protected Route Handler.
- **Login experience** at `/login`: mobile-first, accessible labels and
  `aria-describedby` wiring, `autoComplete="username"` / `current-password`,
  email `inputMode`, 44 px touch targets, a show/hide password toggle, a clear
  loading state, a live error region showing only a generic
  "Incorrect email or password." message, and no horizontal overflow.
- **Logout** in the dashboard header clears the session cookie server-side.
- **Session security**: `HttpOnly`, `Secure` under HTTPS, `SameSite=lax`
  encrypted cookie; Auth.js CSRF tokens on the credential callback; post-login
  redirect destinations validated against an internal allowlist
  (`isValidInternalRedirect`) with a safe `/overview` fallback; no
  authentication tokens in logs; `private, no-store, must-revalidate` on every
  dashboard route, declared statically in `next.config.ts`.
- **Provisioning helper** `scripts/generate-admin-hash.mjs` reads the password
  from stdin and prints only the Argon2id PHC string, so the plaintext is never
  written anywhere.
- **Tests**: 23 unit tests over the auth modules and 24 integration tests over
  the real production server — unauthenticated access is blocked on all eight
  dashboard routes and the API handler, correct credentials succeed, wrong
  password and unknown email both fail with the same generic error, tampered and
  fabricated cookies are rejected, protected responses are non-cacheable,
  logout invalidates the session, the public landing page and PWA assets stay
  reachable, and a deployment with no admin configured fails closed.

### Known limitation (documented, not a bug)

Stateless JWT sessions cannot be centrally revoked before their natural
expiry. Logout clears the browser cookie; a cookie that has already left the
device remains valid up to 7 days. Rotating `AUTH_SECRET` invalidates all
outstanding sessions at once. See ADR-009.

## What is deliberately not implemented

Per the current scope, the following are **absent by design**:

- Database **write-path layer for the catalog, buttons, customers and
  conversations** — Phase 03C-A delivered it for settings, languages and message
  templates; the remaining tables get their own layers in Phases 05–09.
- Dashboard UI for settings and bot content — Phase 04; the data-access APIs it
  will call are in place (see "Exact prerequisites for Phase 04" above).
- Telegram API calls or webhooks (grammY) — Phase 06.
- **Any payment, checkout, order or invoice functionality** — deferred, not started
  (ADR-013). The MVP is a catalog with seller inquiries; nothing is wired up and no
  payment entity exists in the data model.
- Catalog, product and button-tree CRUD (the dashboard editor) — Phases 05.
- Customer, inquiry and messaging runtime — Phase 07.
- Background workers, queues or cron jobs.
- Real-time updates.
- **Service worker / offline support.** This is an admin application; caching
  dashboard data or authenticated responses is a security risk and there is no
  proven offline requirement yet. See ADR-008 in
  [ARCHITECTURE.md](./ARCHITECTURE.md).
- **Web Push Notifications** and any VAPID key material.
- **A custom install button.** Installation relies on the browser's own prompt,
  which appears once the manifest, icons and HTTPS criteria are met. No fake
  install affordances exist.
- Dark-mode toggle (token sets exist; the toggle is deferred).
- Localization / RTL for the dashboard (the dashboard is English only; Arabic
  *bot content* is data the dashboard edits — the `languages` and `templates`
  APIs from Phase 03C-A are the surface, and the bot-side rendering is Phase 07).

No fake data, no fake statistics and no non-functional buttons are present.

## Constraints respected

- **No payments in the MVP.** The product is a catalog with displayed prices and seller
  inquiries. An inquiry is a conversation, never a purchase. No payment gateway, no Binance
  or Vodafone API, no financial webhooks, no payment-proof workflow, no settlement engine,
  no invoices, no refunds — none designed, none wired up (ADR-013).
- **Telegram Stars guardrail.** Rabet offers digital services, so Telegram requires
  **Telegram Stars for real digital goods/services sold inside bots**, including where an
  external payment page exists. The bot's `OPEN_URL` action is for **information pages
  only** and must never be used as a checkout or payment redirect or as a Stars workaround.
  Real in-bot sales are a deferred, compliant-Stars future feature. Sources:
  <https://core.telegram.org/bots/payments-stars>, <https://telegram.org/tos/bot-developers>
  §6.2.
- No actual secrets are requested, generated or committed.
- The dashboard still has no database, no Telegram integration and no payment
  processing, so the product as a whole is **not** production-secure yet.
  Authentication itself (Phase 02A) is implemented and tested, but release
  hardening is Phase 10.

## Validation status

### Phase 01B re-run

All commands were executed again on the `chore/phase-01-final-review` branch:

| Command | Result |
| --- | --- |
| `npm ci` | ✅ exit 0 — 675 packages installed |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 — 12 static pages (10 routes + loading/error boundaries) |
| Route probe against `next start` | ✅ all 9 routes 200, `/nonexistent-page` 404 |

Structural checks on the server-rendered HTML all passed: `lang="en"`, a correct
`<title>` on every page, one `<main>` / `<aside>` / `<header>` / `<nav>`
landmark set on every dashboard page, exactly one `<h1>` per page with correct
`<h2>` descendants, `aria-current="page"` on the active link for all 8 dashboard
sections, the skip link resolving to `<main id="main">`, the mobile-nav trigger
present in the markup, and the "Phase 1 · Preview" / "Not production-secure"
markers visible. No server errors were logged.

Known non-blocking finding: `npm audit` reports 9 high-severity advisories, all
in dev-tooling transitive dependencies (`shadcn` registry, `ts-morph`,
`eslint-config-next`). None are runtime dependencies of the deployed app. They
are left untouched to avoid toolchain churn and are queued for Phase 10.

### Phase 01C verification

| Command | Result |
| --- | --- |
| `npm ci` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 — 13 static pages (adds `/manifest.webmanifest`) |
| Route probe against `next start` | ✅ landing 200, all 8 dashboard routes 200, `/nonexistent-page` 404 |

Manifest and asset checks performed against the production server:

- `/manifest.webmanifest` returns 200 with `content-type:
  application/manifest+json` and parses as valid JSON; `start_url: /overview`,
  `scope: /`, `display: standalone` and four icons with explicit `purpose`
  values are all present and correct.
- All five icons plus `/favicon.ico` return 200 with the correct content type;
  the bytes served match the files in the repository (SHA-256), and the PNG
  dimensions read over HTTP are exactly 192², 512² and 180². The maskable
  glyphs sit inside the 80 % safe zone; the `any` glyphs survive a legacy
  circular launcher mask.
- The document head renders `<link rel="manifest">`, `<meta name="theme-color"
  content="#ffffff">`, `viewport` with `viewport-fit=cover`,
  `<meta name="mobile-web-app-capable" content="yes">`,
  `apple-mobile-web-app-title`, `apple-mobile-web-app-status-bar-style` and
  `<link rel="apple-touch-icon" sizes="180x180">`.
- Structural HTML checks from Phase 01B still pass: `lang="en"`, one `<h1>` per
  page, one `<main>` / `<aside>` / `<header>` / `<nav>` landmark set on every
  dashboard page, `aria-current="page"` on the active link, the skip link
  resolving to `<main id="main">`, and the 44 px touch-target classes present
  in the server-rendered markup.

**Security and scope review (no browser available on the VPS):** no service
worker, no Web Push, no VAPID key material and no caching layer were
introduced; `package.json` and `package-lock.json` are unchanged, so no new
dependency was added; a scan of tracked files for secret-like patterns
(RSA/ AWS key shapes, bearer tokens, committed connection strings) found
nothing; `.env.example` still holds commented placeholders only. Next.js
default cache headers were inspected: static asset and HTML responses carry no
private data (the shell has none), but the default `s-maxage` on prerendered
  pages must be revisited in Phase 02 once authenticated responses exist. Vercel
  Deployment Protection remains enabled and untouched.

  This has since been done: Phase 02 declares `private, no-store,
  must-revalidate` on every dashboard route (see ADR-010), so prerendered
  dashboard pages are no longer cacheable at the edge.

### Phase 02A verification

All commands were executed on the `feat/admin-auth` branch. The build was given
a test-only generated `AUTH_SECRET`; no real secret, password or hash was used
or printed by any check.

| Command | Result |
| --- | --- |
| `npm install` | ✅ exit 0 — adds `@node-rs/argon2`, `next-auth`, `zod`, `vitest` |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 — proxy active, dashboard routes gated, `/` and `/login` public |
| `npm run test` | ✅ exit 0 — **4 test files, 47 tests passing** (23 unit + 24 integration) |

The integration suite was run twice consecutively to confirm repeatability
(both runs exit 0 and leave no orphaned server processes or bound ports).

Two real test-harness bugs were found and fixed while validating — see
[PHASE_02_HANDOFF.md](./PHASE_02_HANDOFF.md):

1. Killing only the `npx` wrapper orphaned the `next-server` grandchild, which
   kept port 3210 bound and made the *next* run die with `EADDRINUSE`. Fixed by
   signalling the whole detached process group and awaiting its exit.
2. `freePort` used `lsof -i tcp:PORT`, which matches a socket by **remote** port
   too — so it matched the test process's own outbound `fetch()` connections and
   SIGKILLed the vitest worker itself after the tests had passed. Fixed by
   restricting both lookup strategies to `LISTEN`-state sockets and never
   signalling this process or its parent.

### Phase 02B verification

All commands were executed on the `feat/admin-auth` branch after the Phase 02B
pass. The build was given a test-only generated `AUTH_SECRET`; no real secret,
password or hash was used or printed by any check.

| Command | Result |
| --- | --- |
| `npm ci` | ✅ exit 0 — 722 packages |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 — proxy active, dashboard routes gated, `/` and `/login` public |
| `npm run test` | ✅ exit 0 — **6 test files, 79 tests passing** (31 unit + 8 provisioning + 40 integration) |

The integration suite was run repeatedly, including twice consecutively and on
overridden ports (`RABET_TEST_PORT=4210 RABET_TEST_PORT_2=4211`); every run exited
0, left no orphaned `next-server` process, left no bound port behind, and left no
`rabet-test-*` temp directory in `/tmp`.

Provisioning prompt security fix applied to this branch after the Phase 02B pass:

- **The interactive prompt now hides the password for real.** The previous
  implementation used Node's `readline.question()` with `terminal: true`, which
  the header described as hiding the input. It does not: `terminal: true` makes
  readline's line editor echo every typed character back to the terminal, so an
  operator's password was shown in cleartext on screen (and stayed in the
  terminal scrollback) while it was being entered. The script now switches the
  tty to raw mode, which disables the kernel's keystroke echo — the same
  mechanism `sudo` and `read -s` use — and collects the bytes itself, writing
  nothing to stdout. Not even the password's length is revealed.
- **Fail-closed when hiding cannot be guaranteed.** If stdin is a terminal that
  cannot enter raw mode, the script refuses to prompt and exits non-zero rather
  than display the password; the operator is told to pipe it instead. Empty and
  mismatched inputs still abort without emitting a hash.
- **The shell-history hazard was removed from the docs.** The header previously
  suggested `printf '%s' 'your-password' | …`, which records the password in the
  shell history and the process list. The remaining piped example is fed by
  another process, and every doc now describes the interactive prompt as the
  normal path.
- **No architectural or compatibility change.** The Argon2id parameters and the
  PHC output format are untouched, so hashes still verify in the deployed app,
  and the piped (non-interactive) path still behaves exactly as before. No new
  dependency was added.
- **New test coverage.** `tests/generate-admin-hash.test.ts` (8 tests) drives the
  script through a real pseudo-terminal (`script`) and asserts the typed
  password never appears in the terminal's recorded output — including its
  length as a run of placeholders — plus the mismatch path, the piped path, and
  that the emitted hash verifies with the app's own `@node-rs/argon2`. The PTY
  tests are skipped on platforms without the `script` utility.

What Phase 02B changed in the suite (no existing assertion was removed; the
behaviour they assert is unchanged):

- **Configurable ports.** `RABET_TEST_PORT` / `RABET_TEST_PORT_2` replace the
  hard-coded 3210/3211, defaulting to the old values so an unconfigured run
  behaves as before.
- **Complete cleanup.** The throwaway env directory is now removed in `afterAll`
  (previously it leaked one temp directory per run), and every server the file
  spawns is tracked and reaped even if a test threw before its own `finally`.
- **New coverage.** Expired-session rejection (a genuine JWT past its `exp`,
  minted with the server's own secret), CSRF enforcement (missing and bogus
  tokens), off-origin `callbackUrl` handling on both the callback and Server
  Action paths, the login page's cache policy, PWA asset reachability while
  signed out, absence of a service worker, and absence of credential material in
  response bodies.

What Phase 02B changed in dependencies:

- **`shadcn` moved to `devDependencies`.** It is a build-time tool (a CSS
  `@import` and a CLI); it was never imported by application runtime code. This
  removes its entire transitive subtree — `fast-glob`, `micromatch`, `braces`,
  `ts-morph`, `@shadcn/registry` — from the **production** dependency tree, which
  is where all nine `npm audit` advisories lived. See the security findings below.

Security review performed in Phase 02B (details in
[ARCHITECTURE.md](./ARCHITECTURE.md), ADR-011):

- `npm audit` reports **9 high-severity advisories**, all tracing to a single
  root package `braces` (stack-exhaustion DoS) reached through
  `micromatch` → `fast-glob`. Every path is a **development/build tool**:
  `eslint-config-next` (lint) and `shadcn`/`ts-morph` (component CLI). **No
  runtime or authentication dependency is affected** — not `next`, `next-auth`,
  `@auth/core`, `@node-rs/argon2` or `zod`.
- After moving `shadcn` to `devDependencies`, `npm ls --omit=dev` contains
  **none** of the vulnerable packages. The advisories remain in the dev tree and
  so remain in the audit count, but they are not shipped to Vercel's runtime.
- `npm audit fix --force` was deliberately **not** run: its only "fix" is a
  breaking downgrade of `shadcn` to `1.0.0`, which risks the toolchain for no
  runtime benefit.
- **No application rate limiter exists**, and none is claimed. Argon2id's
  memory-hard cost is the per-attempt brake; a durable, externally enforced
  limiter is recommended before internet-facing access (ADR-011).

## Remaining manual verification

The development VPS has **no browser installed** (no Chromium, Firefox,
Playwright or Puppeteer is available), so pixel-accurate and interactive checks
could not be run here. Static DOM/CSS inspection and HTTP probes were performed
instead — these are **not** a substitute for interactive browser testing. All
of the following need a real browser, ideally the user's Android device against
the Vercel preview:

- [ ] Visual review of the responsive layout at **320, 360, 390, 430, 768,
      1024 px and desktop**, on the landing page, the overview and each section
      placeholder. (Static review found no fixed width exceeding a 320 px
      viewport, but this was not pixel-measured in a browser.)
- [ ] Confirm no horizontal overflow at 320–400 px viewport widths.
- [ ] Confirm the mobile drawer opens, moves focus correctly, navigates on tap
      and closes with `Escape`; confirm the drawer never exceeds the viewport on
      a ~280–320 px screen.
- [ ] Confirm every navigation item and primary button presents a visible
      44 × 44 CSS px touch target.
- [ ] Confirm keyboard tab order through the sidebar and header, and that the
      focus ring is visible on every focusable element (including the plain
      text links that gained rings in this phase).
- [ ] Confirm the loading skeleton and the error boundary render acceptably
      (both are wired into the route group but were not visually triggered).
- [ ] Confirm the active-section accent bar renders as intended in both the
      sidebar and the drawer.

### Authentication checks (require a real browser, provisioned deployment)

The integration suite proves the HTTP behaviour server-side; these need the
interactive UI on a provisioned deployment (`.env` set on the Vercel preview):

- [ ] The `/login` page renders the brand, accessible email and password fields,
      and the error banner is announced by a screen reader on a failed sign-in.
- [ ] The show/hide password toggle works and the email keyboard appears on
      mobile (`inputMode="email"`).
- [ ] Autofill from a password manager fills email + password correctly via the
      `autoComplete` attributes.
- [ ] A signed-in admin who navigates to `/login` is redirected to `/overview`.
- [ ] Signing out from the dashboard header clears the session and lands on
      `/login`; the back button and refresh do not restore dashboard access.
- [ ] An already-authenticated dashboard navigation is not interrupted by the
      proxy redirect on a slow network.

### Phase 02B automated checks that back the list above

These were executed over HTTP against the real production server and are the
evidence for the server-side half of the items above — but they are **not** a
substitute for the interactive UI checks, which need a real browser:

- [x] Unauthenticated requests to all eight dashboard routes and `/api/admin`
      redirect to `/login` and never render dashboard content.
- [x] Correct credentials authenticate and issue a session cookie; wrong
      password and unknown email both fail with the same generic error.
- [x] Tampered, fabricated and **expired** session cookies are all rejected.
- [x] CSRF is enforced: a POST without a token, or with a bogus one, is rejected
      with `MissingCSRF` and issues no session.
- [x] External and protocol-relative `callbackUrl` values are not followed
      off-origin, on both the callback path and the login Server Action.
- [x] `/overview`, `/api/admin` and `/login` all serve `private, no-store`
      cache headers.
- [x] The manifest, all five icons and `/favicon.ico` return 200 while signed
      out, so the installed PWA can always present the login screen.
- [x] No service worker is registered and `/sw.js` / `/service-worker.js` 404.
- [x] The admin password, its Argon2 hash and the session token value never
      appear in any response body.

### PWA installation checks (require an Android device)

These cannot be validated without the target device and were **not** claimed as
passing:

- [ ] Chrome / Edge on Android shows the "Install app" / "Add to Home screen"
      action for the Vercel preview (manifest + icons + HTTPS criteria met).
- [ ] Installing launches a standalone window rooted at `/overview`, with the
      Rabet icon on the home screen and no browser chrome.
- [ ] The status bar area honours the white theme color and the header clears
      the display cut-out in portrait and landscape.
- [ ] The maskable icon is used by adaptive launchers without clipping the
      glyph, and the non-maskable icon survives circular launcher masks.
- [ ] On iOS Safari, "Add to Home Screen" picks up the 180 px Apple touch icon
      and the `apple-mobile-web-app` metadata.

No service worker is registered, so the installed app still requires a network
connection — this is intentional for an admin application in this phase.

---

## What was done in Phase 10A

Phase 10A established the evidence-backed baseline of the Rabet project following the merge of Phase 09 (PR #19, commit `77fc463e088bb62224c396563c4831dd8aa21683`). Full details are recorded in [docs/PHASE_10A_LAUNCH_READINESS.md](./PHASE_10A_LAUNCH_READINESS.md).

Key verified findings & incorporated platform evidence:
1. **Repository & CI Baseline:** Commit `77fc463` is the merge commit on `main`. GitHub Actions CI run `40956004778` passed all jobs cleanly (lint, typecheck, build, auth, migrations, DB integration, and CDP headless Chromium acceptance).
2. **Vercel Production State:** Automatic deployment `7424358926` is `READY` (Deployment ID `DcDwNYek7HBgXPtVNU2ebf1qV7D7`).
3. **Reviewer-Supplied Platform Metadata (2026-10-29):**
   - Vercel project `prj_7JvXLmI0SzqEwNtHXmSqsoSvRZMp`, Team `team_5KLLRkUhqwAgewTcysr1mY6r`.
   - Production environment variables: `AUTH_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD_HASH` are present. `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_WEBHOOK_SECRET` were absent from the listing.
   - Vercel Protection metadata: SSO enabled with `deploymentType: all_except_custom_domains`.
   - Neon metadata: Connected account lists `Rabet_dev`; no independent `Rabet_prod` project visible.
4. **Edge Interception Blocker:** Direct HTTP probe verified that `POST https://rabet-ammarj1.vercel.app/api/telegram/webhook` returns `HTTP/2 302` redirecting to `https://vercel.com/sso-api`. Webhook traffic is intercepted at the edge.
5. **Login Abuse Protection Proposal:** Documented a single-rule Vercel WAF Rate Limiting proposal covering `POST` requests to `^/(login|api/auth/callback/credentials)$` (5 req/min per IP), compatible with all Vercel plans including Hobby.
6. **Hardened Dependency Audit Workflow:** Added `.github/workflows/audit.yml` and `scripts/validate-audit-report.mjs` with automated validator self-testing, exit-code capture, and distinguishing valid reports from collection failures. Production dependencies confirmed completely clean (0 vulnerabilities).
7. **Approval-Controlled Runbook & Android Checklist:** Provided the 10-step cutover sequence with in-process secret handling (`getpass` + `urllib`) and the 10-point physical device verification checklist. Bounded the remaining release roadmap into Phase 10B (DB & WAF preparation), Phase 10C (activation & physical acceptance), and Phase 10D (operational sign-off).
