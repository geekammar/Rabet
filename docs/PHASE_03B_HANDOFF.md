# Phase 03B — Final Handoff (03B-A2: validation, CI & delivery)

**Purpose.** This is the durable, complete record of Phase 03B — the database
foundation for Rabet. It supersedes the 03B-A1 recovery handoff that lived in
this file. It is written so the next session needs **no** access to any previous
conversation: it records what was built, what was verified, how the verification
was reproduced, what remains open, and exactly how to run a safe production
migration.

> **Intended reader:** the product owner reviewing the pull request, and the
> OpenCode instance that continues after Phase 03B is merged. Read
> `docs/DATA_MODEL.md` (the approved design) and `docs/ARCHITECTURE.md` (ADRs)
> alongside this file.

---

## 1. Status — at a glance

| Item | Value |
| --- | --- |
| Branch | `feat/phase-03b-database-foundation` |
| Base | `main` @ `f6a7738` (merge of PR #5) |
| Remote | `origin` → `https://github.com/geekammar/Rabet.git` |
| Status | **Implemented, fully validated, CI green, PR #6 open for review. Not merged.** |
| Production database | **None. Never created, never contacted.** No Neon project exists. |
| Migrations run in production | **None.** The chain has only ever been applied to disposable clusters. |
| Payment / order / invoice entities | **None, anywhere** (ADR-013) |

**Phase 03B-A1** (the previous session) recovered the interrupted schema + test
implementation and brought it to 52 passing DB tests. **Phase 03B-A2** (this
session) performed the final schema review, deepened the migration verification,
fixed one harness bug, wired the DB suites into GitHub CI, updated all
documentation, and delivered the pull request. Nothing was discarded, reset or
rewritten; all 03B-A1 work is preserved.

---

## 2. Commits

| Commit | Contents |
| --- | --- |
| `7be9971` | 03B-A1 recovery checkpoint — schema, migrations, client, DB test suite, the first handoff |
| `f4e754e` | 03B-A2 delivery — harness `--` fix, GitHub CI DB job, README/PROGRESS/ARCHITECTURE/`.env.example` updates, final handoff |
| `2bba9a7` | 03B-A2 CI fixes — the two root causes found by the first CI run (see §17) — **branch HEAD** |

---

## 3. What 03B-A2 changed (delta over 03B-A1)

1. **Fixed a real harness bug.** `npm run test:db` crashed with
   `spawn -- ENOENT`: `scripts/db-test-postgres.mjs`'s `run` handler received the
   literal `--` separator as the command name because `process.argv` keeps it.
   `run()` now strips exactly one leading `--` (and accepts the bare form). The
   bug also orphaned a cluster when it fired, so the failure path was cleaned up
   and the cluster is now stopped whatever happens. **This is why 03B-A1 could
   report `npm run test:db` green while the command actually did not run** —
   03B-A1 had verified the suites via the manual `start` → `vitest` → `stop`
   path, which is unaffected and still documented in §7.
2. **Deep migration verification** (§6) — `drizzle-kit check` against a freshly
   migrated throwaway DB, a generate-and-diff proving the committed SQL is
   byte-identical to a fresh generation, and a full catalog inspection of every
   table, FK, index, trigger and CHECK constraint as actually applied.
3. **Database access security verification** (§8) — a real build plus a bundle
   scan proving no DB module or credential reaches a client bundle, and driver
   source inspection confirming the `db.batch()` transaction strategy.
4. **GitHub CI** (§9) — a second job with an isolated PostgreSQL service
   container that applies the chain, checks schema/migration drift, and runs the
   DB suites. No production secret or database is reachable from CI.
5. **Documentation** (§10) — README, PROGRESS, ARCHITECTURE and `.env.example`
   updated to the implemented state; obsolete Orders/Payments/Services
   instructions removed; the production migration runbook written (§11).

---

## 4. Schema and migration files

### 4.1 `src/db/schema/` — 7 modules, 14 tables, 7 domains

| File | Contents |
| --- | --- |
| `settings.ts` | `bot_setting` (singleton, `CHECK (id = 1)`, currency allowlist `SAR/USD/AED/EGP`), `language` (`char(2)` unique code, `ltr`/`rtl`) |
| `content.ts` | `message_template` (stable `key`), `message_translation` (one row per template per language, 4096-char cap) |
| `catalog.ts` | **Tree 1** — `category` adjacency list (`parent_id`, no depth cap), `category_translation`, `product` (displayed `numeric(18,2)` price, non-negative), `product_translation` |
| `actions.ts` | **Tree 2** — `product_action` adjacency list (`parent_action_id`), 7-value `action_type` allowlist, HTTPS-only `url` CHECK, mutually-exclusive navigation targets, `product_action_translation` (64-char label cap) |
| `customer.ts` | `customer` (Telegram `bigint` id unique, minimal attributes, anonymization-ready) |
| `inquiry.ts` | `inquiry` (frozen `product_snapshot` / `selected_options`, one-active-per-customer-per-product partial unique index), `inquiry_message` (append-only, `UNIQUE (inquiry_id, telegram_message_id)` dedup) |
| `telegram.ts` | `telegram_update` (`update_id` unique — the idempotency lock) |
| `index.ts` | barrel re-export of all seven; imported by the client and the tests |

Every MVP invariant from the approved design is present: both recursive trees,
cross-product parent rejection, cycle prevention, terminal-parent rejection,
sibling-order uniqueness, inquiry reference integrity, immutable snapshots,
Telegram dedup. **No payment, invoice or order entity exists anywhere**
(ADR-013).

### 4.2 Migrations — `drizzle/`

| File | Contents |
| --- | --- |
| `0000_initial_schema.sql` | Drizzle-generated, human-reviewed: 14 tables, 4 enums (`action_type`, `inquiry_status`, `message_author`, `message_delivery`), 19 FKs, 37 indexes including the 5 partial unique indexes, 12 CHECK constraints |
| `0001_tree_and_snapshot_integrity.sql` | Hand-written, idempotent (`CREATE OR REPLACE FUNCTION` / `DROP TRIGGER IF EXISTS`) SQL for the rules TypeScript cannot express: `touch_updated_at` (11 tables), `category_check_ancestry` (C2/C3), `product_action_check_ancestry` (A2/A3/A4-insert), `product_action_guard_menu_capability` (A4-update), `inquiry_freeze_context` (write-once context) |
| `meta/_journal.json` + `meta/0000_snapshot.json` + `meta/0001_snapshot.json` | Required migration metadata — the journal is what `drizzle-kit migrate` and `db:check` read |

**Referential deletion behaviour, as applied** (verified by catalog inspection,
§6):

| Parent | Child | On delete |
| --- | --- | --- |
| `language` | `bot_setting` | `RESTRICT` |
| `category` | `category` (self) | `RESTRICT` |
| `category` | `category_translation` | `CASCADE` |
| `language` | `category_translation`, `product_translation`, `product_action_translation`, `message_translation` | `CASCADE` |
| `category` | `product` | `RESTRICT` (re-parent products first) |
| `product` | `product_action` | `CASCADE` (the tree is owned by the product) |
| `product_action` | `product_action` (self) | `CASCADE` (deleting a branch is a confirmed action) |
| `category` / `product` | `product_action.navigate_*` | `SET NULL` (a moved catalog node leaves a configurable button, not a dangling one) |
| `language` | `customer.selected_language_id` | `SET NULL` |
| `customer` | `inquiry` | `RESTRICT` (conversations outlive account state) |
| `product` | `inquiry` | `SET NULL` (the frozen snapshot keeps the conversation readable) |
| `inquiry` | `inquiry_message` | `CASCADE` (a thread is one unit) |

**The five partial unique indexes:** `category_sibling_sort_order_idx`,
`category_root_sort_order_idx`, `product_action_sibling_sort_order_idx`,
`product_action_root_sort_order_idx` (sibling-order uniqueness; the root indexes
are global across every root, since Postgres treats a `NULL` parent as
distinct), and `inquiry_active_per_customer_product_idx` (at most one active
inquiry per customer per product — `START_INQUIRY` is resume-by-construction).

---

## 5. Final schema review result

**The implementation matches the approved Rabet discovery MVP.** All ten
expected domains are present (bot configuration, localized content, hierarchical
product categories, digital products and displayed prices, recursive
product action-button trees, localized action labels/messages, Telegram
customers, product inquiries, inquiry messages, Telegram update deduplication).
Checked and confirmed: table relationships, foreign keys, constraints, indexes,
referential deletion behaviour, recursive tree safety (cycle/self-parent/
cross-product/terminal-parent rejection, plus the 64-hop safety bound in the
triggers — a resource guard, not a product depth cap), immutable inquiry
snapshots (write-once trigger), message dedup (`UNIQUE (inquiry_id,
telegram_message_id)`), and required migration metadata (journal + snapshots).

**No financial checkout subsystem exists.** No unrelated features were
introduced: no write-path layer, no Telegram handlers, no editor, no seed data.

---

## 6. Migration verification (all on disposable PostgreSQL only)

Every item below was run against a throwaway cluster started by
`scripts/db-test-postgres.mjs` (fresh `initdb`, random loopback port, trust
auth, data directory deleted on stop). **No production or shared database was
ever contacted.**

| Check | Command | Result |
| --- | --- | --- |
| Apply the full chain to a clean DB | `npm run test:db` (and `createTestDatabase()` per test file) | ✅ 14 tables created |
| Tables, FKs, indexes, triggers, CHECKs as applied | catalog inspection script (§7) | ✅ 14 tables, 4 enums, 19 FKs, 37 indexes, 15 named triggers (17 fire events), 12 CHECKs — all matching the design |
| Schema/migration consistency | `npx drizzle-kit check` against a freshly migrated throwaway DB | ✅ "Everything's fine 🐶🔥" |
| Generation equivalence | `drizzle-kit generate` into a temp folder | ✅ **SQL byte-identical** to `0000_initial_schema.sql`; snapshot structure identical |
| Repeatable execution | `migration-chain.test.ts` — re-apply the chain | ✅ object fingerprint unchanged (no duplicated objects) |
| Failure scenario | `migration-chain.test.ts` — a deliberately broken `0002` | ✅ rolls back atomically; the probe table does not survive; the journal is not polluted |
| Integrity rules | `catalog` / `actions` / `inquiry` suites (52 tests) | ✅ all pass — every rejection asserts a specific SQLSTATE, the matching constraint, and that the write did not land |

---

## 7. How to run everything (exact commands)

PostgreSQL 18.6 server tools are installed (`pg_config --bindir` resolves them);
the box is `root` with passwordless `sudo -u postgres`, which the harness uses.
Standard library only — no Docker.

```bash
cd /root/projects/rabet

# ---- Everything except the database (works anywhere) ----
npm run lint            # eslint        — exit 0
npm run typecheck       # tsc --noEmit  — exit 0
npm run build           # needs a throwaway AUTH_SECRET in CI; locally .env.local is read
npm run test            # 130 tests: 84 passed, 46 skipped without a cluster

# ---- Database suites ----
npm run test:db         # ONE command: disposable cluster → 52 DB tests → delete cluster

# or step by step
node scripts/db-test-postgres.mjs start
export RABET_TEST_PG_URL="$(node -e 'console.log(require("/tmp/rabet-test-pg.json").url)')"
npx vitest run tests/db
node scripts/db-test-postgres.mjs stop

# ---- Full suite including the DB suites ----
node scripts/db-test-postgres.mjs start
export RABET_TEST_PG_URL="$(node -e 'console.log(require("/tmp/rabet-test-pg.json").url)')"
npm run test            # 130 tests, 0 skipped
node scripts/db-test-postgres.mjs stop

# ---- Migration consistency ----
node scripts/db-test-postgres.mjs start
export DATABASE_URL="$(node -e 'console.log(require("/tmp/rabet-test-pg.json")).url'.replace('}',''))/rabet_check')"
# (create the DB, then:)
DATABASE_URL=… npm run db:migrate && DATABASE_URL=… npm run db:check
node scripts/db-test-postgres.mjs stop
```

### Per-file DB test breakdown (52 tests)

| Test file | Tests | Covers |
| --- | --- | --- |
| `tests/db/migration-chain.test.ts` | 7 | clean apply, journal, idempotent re-apply, trigger presence, partial indexes, atomic rollback of a broken migration, and that `drizzle-kit push` is wired into no script |
| `tests/db/client.test.ts` | 6 | imports without `DATABASE_URL`, loud credential-free failures, no echo of the connection string, lazy memoization, `db.transaction()` throws on neon-http |
| `tests/db/catalog.test.ts` | 10 | category tree: self-parent, cycle, deleted-parent, sibling/root order uniqueness, `RESTRICT` deletes, cascade of translations |
| `tests/db/actions.test.ts` | 15 | button tree: cross-product parent, terminal parent, type-change-with-children, branch cascade scoping, navigation-target rules, HTTPS check |
| `tests/db/inquiry.test.ts` | 14 | snapshot immutability, one-active-inquiry, message dedup, `SET NULL` on product delete, `RESTRICT` on customer delete |

### Test-suite isolation guarantees

Loopback-only listener, empty `unix_socket_directories`, trust auth with no
password, a random free port, a fresh `initdb` per `start`, one randomly-named
database per test file, `DROP DATABASE` in every `afterAll`, and `DATABASE_URL`
**never** read by the tests (they read `RABET_TEST_PG_URL` only).

---

## 8. Database access security — verified

| Requirement | Verification |
| --- | --- |
| DB client is server-only | `src/db/client.ts` imports `server-only` (line 1) |
| Secrets cannot leak to browser bundles | `npm run build`, then a scan of `.next/static` for `neondatabase`, `drizzle-orm` and `DATABASE_URL` → **no matches** |
| No database credentials committed | `git ls-files \| grep .env` returns only `.env.example` (placeholders); `.env*` is git-ignored. `.env.local` on this box holds only a Vercel-injected `VERCEL_OIDC_TOKEN`, and no value from it appears anywhere in `.next` |
| No production DB connection required for builds or UI shell routes | `npm run build` succeeds with `DATABASE_URL` unset; every current route renders. The client is lazy (`getDb()`), so importing the module never requires the variable, and the first real query fails loudly with a credential-free message |
| Drizzle driver configuration is valid | `drizzle-kit check` passes against a migrated DB; `drizzle-kit generate` is byte-identical; the client test suite asserts the driver's contract |
| Atomic multi-query operations use a supported transaction strategy | Verified in driver source: `drizzle-orm/neon-http/session.js:152,158` throws `No transactions support in neon-http driver` from `transaction()`; `db.batch()` is implemented (`driver.js:65` → `session.js:117`) and runs the statements server-side in one Neon HTTP transaction. Every atomic write will be expressed as `db.batch([...])` with per-site idempotency (ADR-015) |

**Documented limitation (honest, per the mandate).** The `db.batch()` path is
verified at the driver level — the API exists, `transaction()` provably throws,
and the batch implementation is present in the installed driver — but **no
application write path exists yet**, so an end-to-end batch has not been
exercised against a real Neon endpoint, and the local disposable cluster cannot
stand in for it (`neon()` speaks Neon's HTTP API, not raw Postgres). This is
expected: the write-path layer is the next phase. The local DB suites use
`drizzle-orm/postgres-js` (a real Postgres pool), which is why they can prove
the schema's integrity rules directly.

---

## 9. GitHub CI

`.github/workflows/ci.yml` now runs **two required jobs**.

**`verify` — Lint, typecheck, build, auth + unit tests.** Unchanged in intent:
install → `npm run lint` → `npm run typecheck` → build with a per-run generated
`AUTH_SECRET` (`openssl rand -base64 32`, never committed, never logged) →
`npm run test`. The DB suites inside that run skip cleanly (no cluster in this
job); the `db` job covers them.

**`db` — PostgreSQL service — migrations + DB integration tests.** New. Runs on
`ubuntu-latest` with a `postgres:18` service container (`POSTGRES_USER: rabet`,
throwaway credentials that exist only inside the container, which is destroyed
with the job). Steps: wait for readiness → apply the committed chain through
`npm run db:migrate` to a database created for the run → `npm run db:check`
(schema/migration drift gate) → `npx vitest run tests/db` with
`RABET_TEST_PG_URL` pointing at the container.

Design points:

- **The DB suites skip without a designated cluster**, so CI *must* provide one
  or they silently report "skipped" instead of failing — this job is what makes
  them actually run.
- The test harness reads `RABET_TEST_PG_URL` and **never** `DATABASE_URL`, so
  CI cannot accidentally point the create-and-drop tests at anything shared.
- `scripts/db-test-postgres.mjs` is intentionally **not** used in CI — the
  service container replaces it.
- No GitHub secret needs configuring for either job. **No production database is
  reachable from CI.**
- The original authentication suite runs untouched in `verify`.

The exact `db`-job step sequence was reproduced locally against a disposable
cluster (create DB → `db:migrate` → `db:check` → `npx vitest run tests/db`):
migrations applied, check reported "Everything's fine", 52/52 DB tests passed,
and the full suite ran 130/130 with the cluster designated.

---

## 10. Documentation updated

| File | Change |
| --- | --- |
| `README.md` | Status → Phase 03B implemented; tech stack (ORM/Database no longer "planned"); project structure (adds `src/db`, `drizzle/`, `tests/db`, re-scoped dashboard routes); scripts table (+`test:db`, `db:generate`, `db:migrate`, `db:check`); new **Database** section (folder structure, generating migrations, disposable-DB apply, running DB tests, production rule); environment variables (+`RABET_TEST_PG_URL`); roadmap |
| `docs/PROGRESS.md` | Current phase → 03B; phase table (+03A merged, 03B implemented); new **What was done in Phase 03B** section with the verification table; "deliberately not implemented" updated (DB write-path layer is now the next item) |
| `docs/ARCHITECTURE.md` | Tech stack rows; new §3.1 database layer structure; §3 re-scoped routes (Orders/Payments/Services placeholders removed); §6 testing strategy (+ the DB suite); ADR-012 status note |
| `.env.example` | `DATABASE_URL` documented accurately (optional for build, required by the DB layer); new test-only `RABET_TEST_PG_URL`; the obsolete Telegram-Stars-payment variable block replaced by an explicit "no payment variable exists" note |
| `docs/PHASE_03B_HANDOFF.md` | This file |

Obsolete Orders/Payments/Services instructions were removed. Historical
narrative that describes *past* phases (e.g. the Phase 01B roadmap line) is left
intact as history; the current truth lives in the phase-status tables.

---

## 11. Production migration runbook (the operator document)

> **Read before touching any real database.** GitHub `main` is the source of
> truth for code **and** migration files. This runbook is the only sanctioned
> way to migrate a real database.

### 11.1 Preconditions (manual, one-time, owner action)

1. Provision a Neon project (Free plan is enough) in `aws-us-east-2`, the
   closest Neon region to Vercel's `iad1`.
2. Create a **development** branch database. Never develop against the
   production branch.
3. Take a **manual snapshot** of the target branch in the Neon console before
   any migration. Neon snapshots are instant and let you roll back the whole
   branch in one click.
4. Copy the **unpooled** connection string (Neon's pooled string cannot run
   DDL inside `drizzle-kit migrate` reliably). In the Neon dashboard it is the
   "direct connection" / unpooled URL.

### 11.2 Applying the migration

```bash
# From the development VPS, on the exact main commit being deployed.
git fetch origin && git checkout main && git pull --ff-only
git rev-parse HEAD                       # record this in the deploy log

# Use the UNPOOLED connection string, and only ever against the target branch.
export DATABASE_URL="postgresql://USER:PASSWORD@HOST/dbname?sslmode=require"

# 1. See what would change without writing anything.
npx drizzle-kit check

# 2. Apply the committed chain. This runs every pending migration inside one
#    transaction; a failure rolls the whole apply back.
npm run db:migrate

# 3. Confirm the schema landed.
npx drizzle-kit check
```

### 11.3 Hard rules

- **Never `drizzle-kit push`.** It is not wired into any npm script or CI step,
  and the migration-chain test asserts that as code. Schema changes land only as
  generated, reviewed, committed SQL.
- **Never migrate from a Vercel build, a deploy hook, or at application
  startup.** `drizzle.config.ts` documents this; the lazy client means the app
  builds and boots without a database.
- **Never migrate a destructive change without a snapshot.** A failed migration
  rolls back; a *successful* wrong one needs the snapshot.
- **Preview branches are schema-only.** Real customer data is never copied into
  them (DATA_MODEL.md §15.4).
- **Migrate development first, then production**, and record the commit SHA and
  the migration output in the deploy log.

### 11.4 Rollback

Restore the Neon branch snapshot taken in §11.1. The committed migration files
stay untouched; roll back the *data*, not the repository.

---

## 12. Development / Preview / Production isolation plan

| Environment | Database | `DATABASE_URL` | Migrations run by |
| --- | --- | --- | --- |
| **Local VPS** | Disposable cluster from `scripts/db-test-postgres.mjs` (or a Neon dev branch) | `.env.local`, read only by `drizzle.config.ts` and `getDb()` | The developer, by hand |
| **CI** | Isolated `postgres:18` service container, destroyed with the job | Set inline to the throwaway container; `RABET_TEST_PG_URL` for the suites | The workflow (to a DB created for the run) |
| **Vercel Preview** | A Neon **preview** branch, **schema-only** — no customer data | Vercel project env, preview scope | A human, from the VPS, by the runbook |
| **Vercel Production** | The Neon production branch — **not yet provisioned** | Vercel project env, production scope | A human, from the VPS, by the runbook, after a snapshot |

Environments stay isolated because the app **never** migrates itself: the
variable is only read at migration time and at first query, and the migration
step is always a deliberate human action.

---

## 13. Required manual Neon configuration (before production)

Nothing has been provisioned. When the product owner is ready:

1. Create the Neon project and the production branch.
2. Apply the committed chain per the runbook (§11).
3. Set `DATABASE_URL` in the Vercel project's **production** environment scope
   (and the preview branch's scope for the schema-only preview).
4. Decide and seed the minimal business data — `bot_setting` (the singleton),
   the enabled `language` rows, and any `message_template` keys the bot needs.
   Phase 03B deliberately seeds **no** business defaults; see §14 item 4.
5. Keep Vercel Deployment Protection enabled (ADR-011).

**No code change is required for any of this** — that is the point of the lazy,
credential-free-failure client design.

---

## 14. Remaining technical risks

None blocking. Carried forward as knowledge:

1. **`RESTRICT` reports SQLSTATE 23001, not 23503.** A delete blocked by
   `ON DELETE RESTRICT` raises `integrity_constraint_violation` (23001); only
   the *insert-side* FK breach and the *trigger-raised* violations are 23503.
   Any future error-mapping code must expect this. The tests assert the correct
   code at every site.
2. **Root-level `sort_order` uniqueness is global.**
   `category_root_sort_order_idx` and `product_action_root_sort_order_idx` are
   unique across **every** root in the table, not one parent's children. Any
   fixture or write path inserting a root must take a globally unique
   `sort_order` — which is also what the real write path does.
3. **The `db.batch()` path is unexercised end-to-end.** See §8's documented
   limitation. It is verified at the driver level only.
4. **No seed data exists.** `bot_setting`, `language` and `message_template`
   are data, not schema. Decide whether a seed migration or a dashboard-first
   flow owns them before Phase 04.
5. **Local testing does not prove compatibility with every serverless
   configuration.** The suites prove the schema and the driver contract. Neon's
   pooled HTTP endpoint, cold starts and Vercel's region topology are
   configuration concerns that only a real preview deployment can validate —
   deliberately deferred until the owner provisions a project.
6. **The trigger `NOTICE` stream is noisy.** The idempotent `DROP TRIGGER IF
   EXISTS` statements in `0001` emit harmless `does not exist, skipping`
   notices on first apply. They are the price of safe re-application and appear
   only in verbose output.

---

## 15. Safe next-phase recommendations

In order:

1. **Merge this PR** after product-owner review. Do not squash the 03B-A1
   recovery checkpoint away — its message records the recovery.
2. **Write-path layer** — repository functions shaped as `db.batch([...])` with
   per-site idempotency (`ON CONFLICT DO NOTHING` against
   `telegram_update.update_id`, the message-level unique index, and the
   active-inquiry partial index), per ADR-015 / §15.3. The schema is ready.
3. **Seed-data decision** (§14 item 4).
4. **Then** Phase 04 (settings & localization) and Phase 05 (catalog & Button
   Tree Editor). Nothing in Phase 03B starts them.

---

## 16. Guardrails that still apply

Never `git reset --hard`, `git clean -fd` or `checkout -- .` on this branch;
never run `drizzle-kit push`; never migrate against anything but a disposable or
explicitly designated development database; never commit `.env*`; never add
payment, invoice or order entities (ADR-013); never run `pnpm ship` or bump the
app version; and never start a future phase without product-owner sign-off.

---

## 17. Delivery record

| Item | Value |
| --- | --- |
| Pull Request | **https://github.com/geekammar/Rabet/pull/6** (open, `MERGEABLE`, targets `main`) |
| 03B-A1 recovery checkpoint | `7be9971` |
| 03B-A2 delivery commit | `f4e754e` |
| 03B-A2 CI fixes / **branch HEAD** | `2bba9a79197b16e41034e5900436770ce91fa407` |
| GitHub CI | **Both jobs pass** — run `38276438435`: `Lint, typecheck, build, auth + unit tests` ✅ and `PostgreSQL service — migrations + DB integration tests` ✅ (1m each) |
| Vercel Preview | The branch's last Vercel preview — built at the `7be9971` checkpoint, deployment `7014895539` — reports **success** ("Deployment has completed"). Vercel has not created a deployment record for the two 03B-A2 commits as of this check; the owner should confirm on the Vercel dashboard. This is outside the code path and does not gate the review — GitHub CI is the required gate and it is green. |

### 17.1 The first CI run and how it was fixed (root causes, not symptoms)

The first run of PR #6 (`38271860188`) failed **both** jobs. Each root cause was
fixed on this same branch, the fixes were re-verified locally with the exact CI
step sequence, and the second run passed.

1. **`db` job — `ERR_AMBIGUOUS_MODULE_SYNTAX`.** The throwaway-database helper
   inline in the workflow used top-level `await` together with `require()`, which
   Node refuses to compile (the project has no `"type": "module"`). The awaits
   are wrapped in an async IIFE — the exact form that was verified locally. This
   was purely a YAML mistake: the locally-validated command used the IIFE and the
   workflow did not.
2. **`verify` job — the provisioning PTY test echoed the password.** This was a
   genuine, latent race in `scripts/generate-admin-hash.mjs`, not a test defect,
   and **no assertion was weakened to fix it**. `readHidden()` wrote the prompt
   and only then switched stdin to raw mode. Because the prompt can be relayed
   through the terminal and answered by the driving process while the script's
   own synchronous block is still executing, the reply could reach the kernel's
   line discipline while echo was still enabled — so the password was echoed.
   This never reproduced locally (10/10 passes) because it depends on
   cross-process scheduling, and it had passed on `main` by luck; the first PR
   run exposed it. `setRawMode(true)` now runs **before** the prompt is written,
   so no keystroke arriving in response to a prompt can ever be echoed. The
   security property the test asserts is unchanged and the echo window is
   strictly smaller.

Neither fix touched a schema, migration, or integrity assertion.

**The PR is ready for review. It must not be merged automatically, and no
production database must be provisioned or migrated until the product owner
decides.**
