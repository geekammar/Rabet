# Phase 03B — Recovery & Stabilization Handoff (03B-A1)

**Purpose.** A previous OpenCode session implemented most of Phase 03B-A and
stopped at a context/model limit mid-test-run, leaving the work uncommitted.
This file is the durable record of what existed, what was broken, what was
fixed, and exactly how to continue — written so the next session needs **no**
access to the previous conversation.

> **Intended reader:** the OpenCode instance that continues Phase 03B-A2.
> Read `docs/DATA_MODEL.md` (the approved design) and `docs/ARCHITECTURE.md`
> (ADRs) alongside this file.

---

## 1. Current branch and HEAD

| Item | Value |
| --- | --- |
| Branch | `feat/phase-03b-database-foundation` |
| Base | `main` @ `f6a7738` (merge of PR #5, `chore/catalog-inquiries-shell-cleanup`) |
| Remote | `origin` → `https://github.com/geekammar/Rabet.git` |
| HEAD before recovery | `f6a7738` — the branch had **no commits of its own**; all Phase 03B work was uncommitted in the working tree |
| Working tree at recovery start | `package.json` + `package-lock.json` modified; `drizzle.config.ts`, `drizzle/`, `scripts/db-test-postgres.mjs`, `src/db/`, `tests/db/` untracked |

The recovery described here added one checkpoint commit on this branch (see §8)
and **never touched `main`**.

---

## 2. The original interrupted task

Phase 03B-A: implement the approved Phase 03A data model as real Drizzle schema,
generated SQL migrations, a Neon-HTTP client, and a PostgreSQL integration test
suite that proves the database-level integrity rules. The previous session got
through the schema, both migrations, the client, the disposable-Postgres harness
and five test files, and stopped during a test run reported as roughly
**38 passing / 14 failing**, with a visible failure on `tests/db/inquiry.test.ts`
during an INSERT into `category`.

The accompanying message *"Atria-Dawn-Preview is not supported by TokenPlan"* is a
**model/provider limitation**, not a database error — it is why the session
stopped, not a symptom of the bug.

---

## 3. What existed when recovery began (all preserved)

Nothing was discarded, reset or rewritten. The following were already complete
and correct in substance; only their type annotations and test fixtures needed
repair.

### Schema — `src/db/schema/` (7 modules, 14 tables, 7 domains)

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

All MVP invariants from the approved design are present: both recursive trees,
cross-product parent rejection, cycle prevention, sibling-order uniqueness,
inquiry reference integrity, immutable snapshots, Telegram dedup. **No payment,
invoice or order entity exists anywhere** (ADR-013).

### Migrations — `drizzle/`

- `0000_initial_schema.sql` — all 14 tables, 4 enums, 19 FKs, every index
  including the five partial unique indexes. Drizzle-generated, human-reviewed.
- `0001_tree_and_snapshot_integrity.sql` — hand-written, idempotent
  (`CREATE OR REPLACE FUNCTION` / `DROP TRIGGER IF EXISTS`) SQL for the rules
  TypeScript cannot express: `touch_updated_at` (11 tables),
  `category_check_ancestry` (C2/C3), `product_action_check_ancestry`
  (A2/A3/A4-insert), `product_action_guard_menu_capability` (A4-update),
  `inquiry_freeze_context` (write-once context).
- `meta/_journal.json` + two snapshots.

### Client — `src/db/client.ts`

`drizzle-orm/neon-http` over Neon's pooled HTTP endpoint (ADR-015), lazy
`getDb()`, credential-free failure messages, `server-only`.

### Test infrastructure

- `scripts/db-test-postgres.mjs` — disposable `initdb` cluster on a random
  loopback port, trust auth, `start` / `stop` / `run -- <cmd>`; root delegates
  to the unprivileged `postgres` OS user via `sudo`.
- `tests/db/helpers.ts` — one throwaway database per test **file** (created in
  `beforeAll`, dropped in `afterAll`), full migration chain applied per database,
  `RABET_TEST_PG_URL` honoured, `DATABASE_URL` deliberately never read.
- `package.json` scripts added: `test:db`, `db:generate`, `db:migrate`,
  `db:check`. Dependencies added: `drizzle-orm`, `drizzle-kit`,
  `@neondatabase/serverless` (runtime) + `postgres` (dev/test only).

---

## 4. Root causes found (all 14 failures were harness bugs — the schema was sound)

Reproduced exactly (`38 passed | 14 failed`) against a disposable cluster, then
grouped by cause. **No failure was a schema or migration defect.**

### RC-1 — non-unique fixture slugs (9 failures, `inquiry.test.ts`)

`insertCatalogFixture()` hardcoded `slug: "inquiry-category"` and
`slug: "inquiry-product"`. The harness creates **one database per test file**,
shared by every `it` in it, so the second call hit `category_slug_unique`
(SQLSTATE 23505). This is the visible `category` INSERT failure the previous
session saw — the cause was fixture reuse, **not** the category table.

### RC-2 — root `sort_order` collisions (4 failures, `catalog.test.ts`)

`category_root_sort_order_idx` is a partial unique index over **all** root
categories, not just one parent's children. Several tests inserted root
categories relying on the column default `sort_order = 0` (or an explicit `0`),
so they collided with roots created by earlier tests in the same file
(23505 on `category_root_sort_order_idx`).

### RC-3 — wrong assertion shape (1 site, `catalog.test.ts`)

One expectation used `toMatchObject({ code: "23505" })`. The `postgres` driver
surfaces `PostgresError` **wrapped inside `cause`** by Drizzle's
`DrizzleQueryError`, so every such assertion must be
`{ cause: { code: … } }` (as the other 30+ assertions correctly are).

### RC-4 — wrong SQLSTATE for `ON DELETE RESTRICT` (3 sites)

PostgreSQL reports an `ON DELETE RESTRICT` block as **SQLSTATE 23001**
(`integrity_constraint_violation`) — **not** 23503 (`foreign_key_violation`).
Verified empirically against PostgreSQL 18.6 with `DO $$ ... EXCEPTION WHEN
OTHERS THEN RAISE NOTICE '%', SQLSTATE`:

| Operation | SQLSTATE |
| --- | --- |
| `ON DELETE RESTRICT` block (delete blocked) | **23001** |
| Insert-side FK breach (missing parent row) | 23503 |
| `RAISE … USING ERRCODE = 'foreign_key_violation'` in the ancestry triggers | 23503 (as the tests expect) |
| Unique-index violation | 23505 |
| `CHECK` violation / trigger-raised `check_violation` | 23514 |

So the trigger-based assertions (self-parent, cycle, cross-product, terminal
parent) were already correct at `23503`; only the three **delete** assertions
needed `23503 → 23001`. The design docs in `DATA_MODEL.md §11.7` describe
`RESTRICT` behaviour accurately and claim no SQLSTATE, so **no documentation
correction was required** — this is recorded here as new knowledge.

### RC-5 — cross-test data leak in one assertion (1 failure, `actions.test.ts`)

"deleting a branch removes only that branch" asserted the whole
`product_action` table equals `[kept]`, but one database is shared per file, so
earlier tests' trees were still in the table (32 rows instead of 1). The
assertion was scoped to `product_id`.

---

## 5. Fixes applied (smallest correct changes; no test was deleted or weakened)

| File | Change | Root cause |
| --- | --- | --- |
| `tests/db/inquiry.test.ts` | `insertCatalogFixture()` now keys slugs **and** the root `sort_order` off one `nextOrder()` value per call (`inquiry-category-<n>` / `inquiry-product-<n>`); docstring records why | RC-1 |
| `tests/db/inquiry.test.ts` | customer-delete assertion `23503 → 23001`, with a comment explaining RESTRICT vs. FK-violation codes | RC-4 |
| `tests/db/catalog.test.ts` | root-order test takes a fresh `nextOrder()` for `root-a` and collides `root-b` on it (the index is global over roots) | RC-2 |
| `tests/db/catalog.test.ts` | three direct `category` inserts given explicit `sortOrder: nextOrder()` | RC-2 |
| `tests/db/catalog.test.ts` | `{ code: "23505" } → { cause: { code: "23505" } }` | RC-3 |
| `tests/db/catalog.test.ts` | two category-delete assertions `23503 → 23001` | RC-4 |
| `tests/db/actions.test.ts` | branch-cascade survivor query scoped with `.where(eq(productAction.productId, productId))` | RC-5 |

Every expectation that an integrity rule is **rejected** still asserts a
specific SQLSTATE, the matching constraint, and that the write did not land —
none was relaxed to `toBeDefined()` or removed.

### Build/typecheck repairs (needed for `next build`, which the auth suite runs)

The auth integration suite runs `next build`, which type-checks the new `src/db`
code and `drizzle.config.ts`. Four genuine TypeScript errors blocked it:

| File | Error | Fix |
| --- | --- | --- |
| `drizzle.config.ts` | TS1501 — regex `/s` (dotAll) flag needs ES2018, project `target` is ES2017 | rewrote as `/^"([\s\S]*)"$/` (equivalent, target-safe) |
| `src/db/client.ts` | TS2305 — `NeonHttpQuery` is not exported by `@neondatabase/serverless` | removed the import and the cast; `neon()`'s return type is exactly what `drizzle()` accepts |
| `src/db/client.ts` | TS2456 / TS2577 — `type Database` and `createDb()`'s return annotation referenced each other | dropped the return annotation and moved the alias after `createDb` |
| `src/db/schema/catalog.ts`, `actions.ts` | TS7022 / TS7024 — the self-referencing `references(() => category.id)` / `references(() => productAction.id)` create an inference cycle | annotated the thunks `(): PgColumn => …`, which is exactly the signature `references()` accepts |

The `PgColumn` annotations are **type-only** — the runtime thunks are unchanged.
Proven two ways: (a) regenerating the migrations into a temp folder produced
**byte-identical SQL** and identical table/index/FK snapshots; (b) all 52 DB
tests, which apply the committed chain, still pass.

---

## 6. Schema and migration status

- **Status: complete and verified for Phase 03B-A.** No change to any schema,
  constraint, index, trigger or migration line was made during recovery.
- `npm run db:check` was **not** run against any real database (it needs a
  connection and is unnecessary here); equivalence was proven by the
  generate-and-diff in §5 plus 52 passing tests that apply the chain.
- **No production database exists, is provisioned, or was contacted.**
  `DATABASE_URL` is unset; no Neon project was created; no migration was
  executed anywhere but the disposable cluster. This is intentional and remains
  true.

---

## 7. Disposable DB test setup (exactly what to run)

PostgreSQL 18.6 server tools are installed at `/usr/lib/postgresql/18/bin`
(`pg_config --bindir` resolves them); the box is `root` with passwordless
`sudo -u postgres`, which the harness uses. Standard library only — no Docker.

```bash
# One command: start a throwaway cluster, run the DB suite, stop and delete it.
npm run test:db

# Or step by step:
node scripts/db-test-postgres.mjs start          # prints postgresql://rabet@127.0.0.1:<port>/postgres
export RABET_TEST_PG_URL="$(node -e 'console.log(require("/tmp/rabet-test-pg.json").url)')"
npx vitest run tests/db                           # RABET_TEST_PG_URL is what makes the suites run
node scripts/db-test-postgres.mjs stop            # deletes the whole data directory

# Everything else (no database needed):
npm run typecheck      # tsc --noEmit  — clean
npm run lint           # eslint        — clean
npm run test           # full suite    — 130 tests
```

Isolation guarantees already built into the harness: loopback-only listener,
empty `unix_socket_directories`, trust auth with no password, a random free
port, a fresh `initdb` per `start`, one randomly-named database per test file,
`DROP DATABASE` in every `afterAll`, and `DATABASE_URL` never read by the tests.

---

## 8. Verification results (this session)

All commands run on `feat/phase-03b-database-foundation` against the disposable
cluster.

| Command | Before recovery | After recovery |
| --- | --- | --- |
| `npx vitest run tests/db` | 38 passed \| **14 failed** (52) | **52 passed** \| 0 failed \| 0 skipped |
| `npm run test` (full) | 1 file failed (auth build) \| 91 passed \| 39 skipped | **130 passed** \| 0 failed \| 0 skipped (11 files) |
| `npm run typecheck` | 8 errors | **exit 0** |
| `npm run lint` | — | **exit 0** |
| `npx drizzle-kit generate` diff | — | **SQL byte-identical** to the committed chain |

Per-file DB breakdown after recovery:

| Test file | Tests |
| --- | --- |
| `tests/db/migration-chain.test.ts` | 7 |
| `tests/db/client.test.ts` | 6 |
| `tests/db/catalog.test.ts` | 10 |
| `tests/db/actions.test.ts` | 15 |
| `tests/db/inquiry.test.ts` | 14 |
| **total** | **52** |

The original auth suite (`tests/auth.test.ts`, 39 tests) and the provisioning
PTY suite (`tests/generate-admin-hash.test.ts`, 8 tests) are **intact and
passing** — no auth assertion was touched.

---

## 9. Files changed by this recovery

Modified (tracked): none beyond what the previous session already had staged in
the working tree — `package.json`, `package-lock.json`.

Newly committed on the branch (previously untracked): `drizzle.config.ts`,
`drizzle/` (2 SQL + `meta/`), `scripts/db-test-postgres.mjs`, `src/db/`
(`client.ts` + `schema/*`), `tests/db/` (5 suites + `helpers.ts`), and this
handoff document.

Edits made **during recovery** (all listed in §5): `tests/db/inquiry.test.ts`,
`tests/db/catalog.test.ts`, `tests/db/actions.test.ts`, `src/db/client.ts`,
`src/db/schema/catalog.ts`, `src/db/schema/actions.ts`, `drizzle.config.ts`.

---

## 10. Unresolved technical issues

None blocking. Two items to carry forward as knowledge, not defects:

1. **`RESTRICT` → 23001.** Any future test or error-mapping code that catches a
   delete blocked by `ON DELETE RESTRICT` must expect SQLSTATE 23001, not 23503.
   Only the *insert-side* FK breach and the *trigger-raised* violations are 23503.
2. **Root-level uniqueness is global.** `category_root_sort_order_idx` and
   `product_action_root_sort_order_idx` are unique across every root in the
   table. Any fixture or future write path inserting a root must take a globally
   unique `sort_order` — which is also what the real write path does
   (renumbering siblings to stay gapless and unique).

Not an issue but worth remembering: the "unsupported by TokenPlan" message the
previous session saw was a provider limit. If it recurs, stop and hand off; it
is unrelated to the code.

---

## 11. Next actions for Phase 03B-A2

The schema, migrations, client and DB test foundation are done and green, so
03B-A2 should **not** redo them. Suggested scope, in order:

1. **CI wiring.** Add a PostgreSQL service container to the GitHub Actions
   workflow and set `RABET_TEST_PG_URL` there, so `tests/db` runs in CI exactly
   as it does locally (`scripts/db-test-postgres.mjs` is intentionally not
   needed in CI). Note `npm run test` currently *skips* the DB suites when no
   cluster is designated — CI must provide one or the suites silently skip.
2. **Migration-runbook polish.** A short runbook for the hand-applied production
   migration (unpooled connection, manual snapshot first, `drizzle-kit migrate`,
   never `push`) — the rules are in `DATA_MODEL.md §17.3` but not yet a
   step-by-step operator document.
3. **`drizzle-kit check` in CI** (or a pre-commit gate) to catch schema/migration
   drift; it needs a DB connection, so it belongs in the DB job from step 1.
4. **Seed data decisions.** Phase 03B deliberately seeds no business defaults.
   If `message_template` keys are needed before Phase 04, decide whether a seed
   migration or a dashboard-first flow owns them.
5. Then proceed to the write-path layer (repository functions shaped as
   `db.batch([...])` with per-site idempotency, per ADR-015 / §15.3) — the
   schema is ready for them.

---

## 12. Safe starting point for a fresh session

```bash
cd /root/projects/rabet
git status --short                     # confirm the tree matches §9
git log --oneline -3                   # expect the recovery checkpoint on feat/phase-03b-database-foundation
npm ci                                 # already installed; reinstall if node_modules is gone
npm run test:db                        # expect: Test Files 5 passed, Tests 52 passed
npm run test                           # expect: Test Files 11 passed, Tests 130 passed
npm run typecheck && npm run lint      # both exit 0
```

If `npm run test:db` reports skips instead of passes, `RABET_TEST_PG_URL` is not
set and no cluster is running — start one with
`node scripts/db-test-postgres.mjs start`, or just use `npm run test:db`, which
manages the cluster itself.

**Guardrails that still apply:** never `git reset --hard`, `git clean -fd` or
`checkout -- .` on this branch; never run `drizzle-kit push`; never migrate
against anything but a disposable database; never commit `.env*`; and do not add
payment, invoice or order entities (ADR-013).
