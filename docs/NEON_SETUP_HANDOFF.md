# Phase 03B-B1 — Neon Development Setup Wizard: recovery & completion

**Purpose.** This is the durable record of the reusable Neon **development** setup
wizard (`npm run db:setup:dev`). It is written so the next session needs no
access to any previous conversation: it records what was recovered, what was
broken, what was fixed, exactly how to run the wizard, and what remains open for
Phase 03B-B2.

> **Intended reader:** the product owner, and the OpenCode instance that continues
> into Phase 03B-B2. Read `docs/PHASE_03B_HANDOFF.md` (the database foundation)
> alongside this file — the wizard is the operator tool for *that* schema and
> *that* migration chain.

---

## 1. Status — at a glance

| Item | Value |
| --- | --- |
| Branch | `feat/neon-dev-setup-wizard` (unchanged — work continued in place) |
| Base | `main` @ `a798c5e` (merge of PR #6, the Phase 03B database foundation) |
| Recovery model | The previous session left the wizard **uncommitted** on this branch. Nothing was discarded, reset or rewritten. |
| Command | `npm run db:setup:dev` — committed as a package.json script |
| Wizard status | **Functional and verified.** First-time setup and existing-database reconnect both proven end to end against real PostgreSQL. |
| Real Neon `Rabet_dev` | **Never contacted.** No Neon account, project or endpoint was touched by this work. |
| Production | **Never contacted, never configured, never migrated.** |
| Automated tests | `218 passed` (full suite with a designated cluster); `74` wizard flow tests; `13` wizard-SQL tests |
| `npm run lint` / `npm run typecheck` | Both clean (exit 0) |

---

## 2. Recovery state — what the interrupted session left

The previous session stopped mid-implementation. `git status` on arrival showed
uncommitted work only — no commit, no separate stash:

| Path | State | Verdict after inspection |
| --- | --- | --- |
| `scripts/setup-neon-dev.mjs` | untracked, ~3000 lines | **Substantially complete and well-structured.** Kept as-is. |
| `tests/wizard/setup-neon-dev.test.ts` | untracked, 72 tests | Complete; 15 were failing for one fixable reason (§3 item 3). Kept and extended. |
| `tests/db/wizard-sql.test.ts` | untracked, 13 tests | Complete and passing. Kept as-is. |
| `package.json` | modified — adds the `db:setup:dev` script | Correct. Kept. |
| `mkdb-tmp.mjs` | untracked, 7-line throwaway DB-creation helper | Left untouched (not part of the wizard; not committed). |

**Nothing was restarted from scratch.** The existing structure — a single library
script with an injected IO/database/subprocess surface — was judged maintainable
and compact, so the "simplify" step was **not** applied: splitting it into
`scripts/lib/neon-setup/` modules would have been churn with no clarity gain, and
the task explicitly forbids rewriting functioning components for a preferred
folder structure. ONE public command, ONE script.

### 2.1 Three real defects the interruption left behind

Found by running the recovered tests and the real CLI, and fixed in place:

1. **The wire-protocol driver was never imported (critical).**
   `createPostgresSql()` used the `postgres` driver, but the script's import block
   only imported `@neondatabase/serverless`. Running the CLI produced
   `postgres is not defined` on the first connection attempt — **the wizard could
   not connect to any database at all.** Fixed by adding
   `import postgres from "postgres"` (`postgres` is already a committed
   devDependency, `^3.4.9`).

2. **The connection-retry loop was unbounded (interrupted-session hazard).**
   When the connection failed, the wizard asked "try connecting again?" with a
   default of *yes*. On an interrupted session — SSH died, or a piped stdin ran
   out — the prompt resolves to an empty string, which takes that default, so the
   wizard retried **forever**. Fixed on two fronts:
   - `MAX_MANUAL_CONNECT_RETRIES = 3` bounds the loop regardless of cause.
   - `createRealIo()` now exposes `isInputExhausted()`; the wizard stops the
     moment the input stream has ended, with a clear "Input ended (the session
     was interrupted)" message instead of asking a question nobody can answer.
   Both are covered by two new regression tests.

3. **The Neon HTTP batch check bypassed the injected test surface.**
   Every external surface is injected except one: `checkNeonHttpBatch()` called
   `createNeonSql()` directly, so the 15 flow tests that reach validation made a
   **real network call to a fake `*.neon.tech` URL** and failed on the DNS/auth
   error. Fixed by adding `httpConnect` to the injected surface (defaulting to
   `createNeonSql`, so production behaviour is unchanged) and driving it through
   `ctx`. This also completed the requirement to report the two transports as
   **separate checks** — wire-protocol batch and Neon HTTP batch are distinct
   result rows and are never conflated.

A fourth, smaller wiring gap was fixed at the same time: `connectWithRetry()` was
not receiving the wizard's injected `sleep`, so its backoff always used the real
timer and the retry tests ran ~10s slower than necessary.

---

## 3. Core wizard — implementation status

`scripts/setup-neon-dev.mjs` is a library with a CLI entry point. Every external
surface (terminal IO, the wire-protocol connection, the Neon HTTP connection,
subprocess execution, and `sleep`) is injected, which is what lets the automated
tests drive every branch with mocks. The functions the tests rely on are exported
(`parsePgUrl`, `validateConnectionUrl`, `readJournal`, `verifyMigrationFiles`,
`computeMigrationHashes`, `buildRowCountQuery`, `classifyDbState`, `buildChildEnv`,
`parseYesNo`, `createNeonSql`, `createPostgresSql`, `isNeonHttpCapable`,
`connectWithRetry`, `describeConnectionError`, `runWizard`, `maskUrl`, `maskEndpoint`,
`redact`, `readEnvLocalUrl`, `writeEnvLocalUrl`, `EXPECTED_*` constants, `QUERIES`).

The interactive sequence, as required:

| Step | Name | What it does |
| --- | --- | --- |
| 1 | Checking project | Verifies it is the Rabet repo (git remote identity), warns on uncommitted *migration-chain* changes, records the exact revision, checks Node.js 18+ (22 recommended), and verifies the committed migration files against the journal. |
| 2 | Checking local dependencies | Checks `node_modules` for `drizzle-kit` / `drizzle-orm` / `@neondatabase/serverless`; **asks** before running `npm ci` (`package-lock.json` is never modified). |
| 3 | Connecting to Neon | Obtains the connection URL, validates syntax + TLS, connects read-only with bounded retries, shows masked non-sensitive metadata, and requires explicit confirmation the target is the dedicated `Rabet_dev` development database. |
| 4 | Inspecting database state | Read-only SQL only: application tables, `drizzle.__drizzle_migrations`, row counts → a state classification (`empty` / `partial` / `configured` / `inconsistent` / `drift`). |
| 5 | Reviewing migrations | Lists the committed chain with applied/pending per entry, runs `npm run db:check` as a repository consistency check, and prints a read-only summary. |
| 6 | Applying approved changes | Asks for explicit approval (default **no**); requires a typed database name when application data exists; runs `npm run db:migrate` with the verified URL in a sanitized child env; then re-inspects the database rather than trusting the exit code. Skipped entirely when nothing is pending. |
| 7 | Validating results | The full read-only validation (§7) including a read-only batch and, when applicable, a Neon HTTP batch. |

After step 7 the wizard optionally offers to persist the URL to `.env.local`
(mode `0600`, unrelated values preserved, git-ignored), and — only with the
explicit `--vercel-preview` flag — the optional Vercel Preview step.

---

## 4. Exact CLI entrypoints

```bash
npm run db:setup:dev                  # interactive setup (default)
npm run db:setup:dev -- --check       # read-only preflight: steps 1–5, NO writes
npm run db:setup:dev -- --vercel-preview
                                      # also offer the OPTIONAL Vercel Preview step
npm run db:setup:dev -- --help        # usage
```

`--check` was verified against a throwaway database: it reports
"Read-only preflight: no problems found", exits `0`, and leaves the target with
**zero tables and no `drizzle.__drizzle_migrations`** — it does not migrate,
seed, install packages, or modify the database in any way. An unknown option
exits `2` with the help text.

---

## 5. Expected input variables

| Variable | Read by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | the wizard (optional), `drizzle.config.ts`, `src/db/client.ts` | The development connection string. No new variable was invented — the existing project convention is reused. |
| `RABET_TEST_PG_URL` | the DB test suites only | Designates the throwaway cluster. **The wizard never reads it and never forwards it to a subprocess.** |

Credentials are accepted, in priority order:

1. an explicitly exported `DATABASE_URL` in the shell (still re-verified exactly
   like a pasted one, and the owner is asked before it is used);
2. an existing, confirmed local `.env.local`;
3. secure interactive terminal input — read with raw mode enabled **before** the
   prompt is written (the same ordering the reviewed
   `scripts/generate-admin-hash.mjs` uses), so no keystroke can be echoed.

The wizard prefers the **direct / unpooled** URL and warns when the host looks
like Neon's pooled endpoint (`-pooler`), because `drizzle-kit migrate` cannot run
DDL reliably through the pooler. It never passes a credential on a command line,
never echoes a connection string, and runs every line of output through `redact()`
as a safety net.

---

## 6. Development-environment safeguards

- **Repository identity.** Refuses to run when the git remote is not
  `github.com/geekammar/rabet`.
- **Syntax + TLS.** Rejects non-PostgreSQL schemes, missing credentials, a
  missing database name, and any external URL that disables TLS
  (`sslmode=disable|allow|prefer`); adds `sslmode=require` to an external URL and
  says so.
- **Target confirmation.** Shows a masked endpoint and the database name, and
  requires an explicit "yes, this is the dedicated `Rabet_dev` development
  database" before any write. A name that looks non-dev (`prod`, `live`, …) draws
  an extra warning that a name is not proof of environment.
- **No identity overclaim.** The wizard does **not** claim to have verified the
  Neon Console project display name — PostgreSQL metadata alone cannot prove it.
  It shows what was actually inspected (database name, masked endpoint, role,
  version, TLS) and leaves the project-level confirmation to the operator. No
  Neon API integration exists, so no Neon API metadata is used.
- **Sanitized child env.** `buildChildEnv()` forwards only neutral keys plus the
  single verified `DATABASE_URL`; `RABET_TEST_PG_URL`, `AUTH_*` and `ADMIN_*` are
  never forwarded. The verified URL wins over any stale `DATABASE_URL` in
  `.env.local` because `drizzle.config.ts` keeps already-set environment keys.
- **`.env.local` writes are opt-in, and safe.** Approval required, mode `0600`,
  unrelated values preserved line-for-line, and the file stays git-ignored. The
  wizard never silently overwrites an existing `DATABASE_URL` — it shows the
  masked current value and asks.
- **Never done:** `drizzle-kit push`; regenerating migrations at runtime; dropping
  or resetting tables, databases or branches; automatic schema-drift repair;
  seeding records; setting `RABET_TEST_PG_URL`; passing credentials on a command
  line; printing a connection string; running a `git` write command.

> **Cleanup performed during recovery.** The interrupted session's
> `writeEnvLocalUrl` testing had left the **test-fixture** URL
> (`ep-cool-12345…neon.tech`, not a real endpoint) in this box's git-ignored
> `.env.local`. It was removed so a plain `npm run db:migrate` fails with a clear
> "not configured" message instead of trying a nonexistent endpoint. The box's
> real `VERCEL_OIDC_TOKEN` was preserved and the file mode kept at `0600`.

---

## 7. Checks actually performed (step 7 validation)

All read-only. Against a freshly set up throwaway database the wizard reported
`17/17 passed`:

| Check | Verified |
| --- | --- |
| `project` | Repository identity, Node version, committed migration files |
| `dependencies` | Required packages present |
| `connection` | Connects, TLS, target confirmed as development |
| `inspection` | Read-only state classification |
| `migration-check` | `npm run db:check` — committed journal + snapshots consistent |
| `review` | Chain listed with per-entry applied/pending status |
| `apply` | What this run applied (empty when already configured) |
| `tables` | **14/14** expected tables present, none unexpected |
| `migration-history` | Applied `drizzle.__drizzle_migrations` hashes **byte-for-byte equal** to the committed files' sha256, in order |
| `indexes` | **17/17** expected indexes |
| `constraints` | **12/12** critical CHECK constraints |
| `recursive-trees` | Both self-referencing tree foreign keys (`category`, `product_action`) |
| `select-1` | A harmless `SELECT 1` succeeds |
| `batch-read-only` | Two statements in one **read-only transaction** over the wire protocol |
| `neon-http-batch` | A read-only batch over the **Neon HTTP API** when the endpoint can be served by it; otherwise reported `not applicable` — reported as a **separate** row, never conflated with the wire-protocol result |

---

## 8. First-time setup flow (verified)

Proven against a throwaway PostgreSQL database created for the purpose:

1. The wizard classifies the empty target as `empty` (no application tables, no
   migration journal).
2. It lists both committed migrations as pending and runs `npm run db:check`.
3. After explicit approval it runs `npm run db:migrate` with the verified URL.
4. It re-inspects the database rather than trusting the exit code, and reports
   exactly what this run applied.
5. Step 7 validates the result: `14/14` tables, `17/17` indexes, `12/12`
   constraints, both trees, byte-for-byte migration history, and the read-only
   batches.

Result: "Development database setup complete", exit `0`.

---

## 9. Existing-database reconnect flow (verified — the critical requirement)

Proven by running the wizard a **second** time against the same configured
database, exactly as a replacement VPS would:

1. It connects to the existing database and inspects the committed migration
   history.
2. It compares the applied hashes against the committed files and verifies
   expected table/index/constraint presence.
3. It **does not** re-run migrations, **does not** recreate existing tables, and
   **does not** duplicate migration records — the journal stayed at exactly `2`
   rows and the tables at exactly `14` across the run.
4. With nothing pending it reports:

   > Development database is already configured. No migrations are pending, so
   > nothing is written. Validating instead.

   …and the final report reads "Development database setup complete" with
   `apply — already configured`.

When new migrations *are* pending, the wizard names them and asks for explicit
approval before applying anything — never silently.

When **schema drift** is detected (unknown tables, an applied history that
matches no committed file, a journal ahead of the repository, or a journal that
claims complete while tables are missing) the wizard **stops without
modification** and points at the Neon snapshot for recovery. It never repairs
drift.

---

## 10. Safe recovery — what the wizard handles

| Situation | Behaviour |
| --- | --- |
| Incorrect URL | A credential-free, actionable message (bad credentials / network / nonexistent database); never reprints the string. |
| Temporary connection failure | Bounded automatic retries with exponential backoff (3 attempts), then a bounded number of manual retries. |
| Interrupted SSH session | Detects exhausted input and stops immediately — it will not answer its own "try again?" with the default. |
| Missing dependencies | Asks before `npm ci`; declines cleanly and stops. |
| Already-applied migrations | Detected and skipped; nothing is repeated. |
| Repeated wizard execution | Idempotent by construction — re-running inspects real state and repeats nothing already done. |
| Previously completed setup | Reported as already configured; the wizard validates instead of writing. |
| Non-zero migration exit code | The wizard inspects the database to diagnose (drizzle-kit's terminal renderer clears the failing line), distinguishes "still empty" from "partially applied", and never claims success after an ambiguous or partial result. |

For any unsafe or ambiguous state it **stops with instructions** rather than
guessing. It never deletes a database, branch or volume.

---

## 11. How to run everything (exact commands)

```bash
cd /root/projects/rabet

# ---- Wizard flow tests (no cluster needed) ----
npx vitest run tests/wizard/setup-neon-dev.test.ts     # 74 tests

# ---- Wizard SQL tests (need the throwaway cluster) ----
node scripts/db-test-postgres.mjs start
export RABET_TEST_PG_URL="$(node -e 'console.log(require("/tmp/rabet-test-pg.json").url)')"
npx vitest run tests/db/wizard-sql.test.ts             # 13 tests
node scripts/db-test-postgres.mjs stop

# ---- Full suite ----
npm run lint            # eslint        — exit 0
npm run typecheck       # tsc --noEmit  — exit 0
node scripts/db-test-postgres.mjs start
export RABET_TEST_PG_URL="$(node -e 'console.log(require("/tmp/rabet-test-pg.json").url)')"
npm run test            # 218 tests, 0 skipped
node scripts/db-test-postgres.mjs stop

# ---- The wizard itself, read-only ----
npm run db:setup:dev -- --check
npm run db:setup:dev -- --help
```

CI already covers both suites with no workflow change: the `verify` job's
`npm run test` picks up `tests/wizard/`, and the `db` job's
`npx vitest run tests/db` picks up `tests/db/wizard-sql.test.ts` against its
PostgreSQL service container.

---

## 12. Known limitations (honest)

1. **No Neon API identity verification.** The wizard can verify syntax, TLS,
   reachability and schema, but PostgreSQL metadata cannot prove the Neon Console
   project display name. It deliberately does not claim to, and there is no Neon
   API integration to consult. Project-level confirmation stays with the operator.
2. **The Neon HTTP batch check is only reached on a real Neon endpoint.** Against
   a local cluster it is correctly reported `not applicable` — the wire-protocol
   batch already proved reachability and read-only behaviour. It has therefore
   been exercised only through the injected test surface, never against a live
   Neon endpoint, because no Neon account exists in this work.
3. **`db.transaction()` is unavailable on `neon-http`.** The wizard's read-only
   batch uses the driver's supported path; that contract was verified in
   `PHASE_03B_HANDOFF.md` §8 at the driver level.
4. **`drizzle-kit check` is a repository consistency check, not a dry-run.** It
   reports success on an empty database, so the wizard never advertises it as a
   preview of the SQL that will run — the pending-migration list in step 5 is the
   preview.
5. **The trigger `NOTICE` stream is noisy** on first apply (the idempotent
   `DROP TRIGGER IF EXISTS` statements). Harmless; the price of safe re-application.
6. **The wizard is development-only by policy, not by network policy.** It has no
   way to know a pasted URL is production other than asking the operator to
   confirm. The confirmation is explicit and defaults to *no*.

---

## 13. Pending work for Phase 03B-B2

Deliberately **not** started here:

1. **Real-Neon end-to-end validation.** Point the wizard at the owner's actual
   `Rabet_dev` project and run `--check` (read-only) to exercise the genuine Neon
   HTTP batch path and the TLS handling against a live endpoint. Requires the
   owner's connection string and must be the owner's action.
2. **The optional Vercel Preview step** is implemented and unit-tested, but has
   never run against a real Vercel project (no CLI, no link record on this box).
   It degrades to a manual-step report in every unverified case and writes
   Preview scope only, never Production.
3. **Seed-data decision** (carried from `PHASE_03B_HANDOFF.md` §14 item 4) —
   `bot_setting`, `language`, `message_template` are data, not schema. The wizard
   deliberately seeds nothing.
4. **Write-path layer** (carried from `PHASE_03B_HANDOFF.md` §15 item 2) — the
   schema is ready; the wizard does not start it.
5. **Merge / PR.** No pull request was created or merged by this work. The
   checkpoint commit (§14) stays on the feature branch.

---

## 14. Checkpoint commit and branch

| Item | Value |
| --- | --- |
| Branch | `feat/neon-dev-setup-wizard` |
| Checkpoint | The commit created at the end of this recovery, on this branch only. |
| Pushed | This branch only. `main` was not touched. |
| Pull request | **None created, none merged.** |
| Files in the checkpoint | `scripts/setup-neon-dev.mjs`, `tests/wizard/setup-neon-dev.test.ts`, `tests/db/wizard-sql.test.ts`, `package.json` (the `db:setup:dev` script), this handoff. |

`mkdb-tmp.mjs` (a throwaway DB-creation helper from the interrupted session) is
left untracked and is intentionally not part of the commit.

---

## 15. Guardrails that still apply

Never `git reset --hard`, `git clean -fd` or `checkout -- .` on this branch;
never run `drizzle-kit push`; never migrate against anything but a disposable or
explicitly designated development database; never commit `.env*`; never run the
destructive integration fixtures against persistent `Rabet_dev`; never point
`RABET_TEST_PG_URL` at a persistent Neon database; never add payment, invoice or
order entities (ADR-013); never run `pnpm ship`, bump the version, provision or
configure Production, or execute Production migrations; and never start a future
phase without product-owner sign-off.

**Do not start Phase 03B-B2 automatically.**
