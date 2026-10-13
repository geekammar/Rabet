# Phase 03B-C1 — Neon DEV Actions runner: recovery, CI fix, identity correction

Handoff for the continuation phase that recovered interrupted work, fixed the
eight CI failures on PR #8, and corrected the pinned Neon database identity.

- **Branch:** `feat/phase-03b-neon-dev-actions-migrations`
- **PR:** https://github.com/geekammar/Rabet/pull/8 (existing, still open — no
  new PR was created)
- **Phase:** 03B-C1 (recovery and repair). Phase 03B-C2 is **not** started.

---

## 1. Recovered branch and working-tree state

The interrupted session was recovered by inspection only — nothing was reset,
discarded, force-pushed or recreated:

- `git status --short` on entry showed one modified file,
  `tests/db/neon-dev-actions.test.ts`, containing an in-progress harness fix
  (the `GITHUB_*` filter described in §3). That work was **kept** and finished.
- The branch was already on `feat/phase-03b-neon-dev-actions-migrations` at
  commit `408d9a3` ("test(db): use a single throwaway database for the actions
  runner suite"), which is the last pushed commit named in the brief.
- The two commits already on the branch — `d5387b8` (the workflow) and
  `408d9a3` (the throwaway-database rework) — are untouched.
- No untracked files were present; nothing was cleaned.

## 2. Existing implementation preserved

The whole of PR #8's delivery is intact and unchanged in substance:

- `.github/workflows/neon-dev-migrate.yml` — the manual `workflow_dispatch`
  workflow. **Not modified.** Its trigger (`workflow_dispatch` only, no
  `push`/`pull_request`/`schedule`), its `concurrency` group, its
  `permissions: contents: read`, its mode/confirmation pre-validation gate, and
  its environment-secret handling are exactly as committed.
- `scripts/neon-dev-actions.mjs` — the runner. Only **one** line of behaviour
  changed: the value of `EXPECTED_DEV_DB_NAME` (§5), plus the doc comment above
  it. Every gate — GitHub context, target identity, confirmation, drift
  detection, re-inspection after migrating, redaction — is byte-for-byte the
  same.
- `scripts/setup-neon-dev.mjs`, `drizzle.config.ts`, `package.json` — untouched.
- All protections listed in the brief are still in force, verified by the test
  runs in §6:
  - `workflow_dispatch` only, `main` only (guard in code + workflow trigger);
  - inspect read-only by default;
  - exact approved host **and** database, both required;
  - DIRECT/unpooled connection (pooled `-pooler` host refused with its own
    message);
  - TLS required (`sslmode=require` added or enforced; `sslmode=disable`
    refused);
  - `MIGRATE_RABET_DEV` confirmation, checked before connecting **and** at the
    point of writing;
  - secret redaction on every output line and on subprocess output;
  - no schema-drift auto repair, no `drizzle-kit push`, no branch reset;
  - reviewed migration chain only (journal + snapshots + SQL verified by
    `verifyMigrationFiles`);
  - no automatic production migrations.

## 3. Root cause of the eight CI failures

Verified from the failed run (38427769861) logs and from source, not assumed.

**The `verify` job passed.** The `db` job failed in
`tests/db/neon-dev-actions.test.ts` with exactly **8 failures / 10 tests**:
`Test Files 1 failed | 7 passed (8)`, `Tests 8 failed | 70 passed (78)`.
Every failure was an outcome mismatch of the same shape — the runner returned
`refused` where the test expected `inspected` / `migrated` / `manual-review` /
`failed`. The two tests that passed were the two that already assert `refused`
("refuses a URL whose database name is not the pinned database" and "refuses
migrate mode without the confirmation phrase").

**Why `refused`:** the integration harness builds the runner's environment in
`cleanEnv()` by copying `process.env`. On a PR check, GitHub injects
`GITHUB_ACTIONS=true`, `GITHUB_EVENT_NAME=pull_request` and
`GITHUB_REF=refs/pull/8/merge`. The runner's production guard
(`validateGithubContext` in `scripts/neon-dev-actions.mjs:160`) **correctly**
refuses any GitHub event other than `workflow_dispatch` and any ref other than
`refs/heads/main`, and it does so *before* any connection is opened. So all
eight database-behaviour tests were short-circuited at the gate and never
reached the disposable PostgreSQL database.

This is a **test-harness contamination** bug, not a runner bug: the guard is
right, the harness was leaking a real workflow context into a process that is
not a workflow run.

## 4. Actual fixes made

1. **`tests/db/neon-dev-actions.test.ts` — isolate the execution context
   (finished the recovered in-progress edit).** `cleanEnv()` now also drops
   every `GITHUB_*` variable, so the runner sees a *local* context
   (`GITHUB_ACTIONS !== "true"`). This is the honest model: a test process is
   not a GitHub workflow run. The production guard is **not** weakened — it is
   untouched, and its negative cases are covered explicitly (see #2 below).
   Because `cleanEnv()` is test-harness code, the real CLI (`runCli`, which
   reads `process.env` directly) is unaffected.

2. **`tests/wizard/neon-dev-actions.test.ts` — added an explicit negative test
   proving `pull_request` is rejected.** A new case in "GitHub context
   restrictions" drives the full runner under the exact PR-check context
   (`GITHUB_EVENT_NAME=pull_request`, `GITHUB_REF=refs/pull/8/merge`) and
   asserts `refused` with no `db:migrate` call. The existing `push` rejection
   and the four `validateGithubContext` cases (off-GitHub, non-dispatch event,
   non-main ref, valid dispatch from main) are preserved. **No safety gate was
   removed or weakened, and no failing test was skipped.**

3. **`tests/db/wizard-reconnect.test.ts` — isolate the cluster snapshot from
   concurrent sibling suites.** This is a *second, independent* root cause that
   fix #1 exposed. Previously the actions suite was refused before connecting,
   so it never created its throwaway database. Once it works, it holds one
   database (`rabet_actions_single_*`) for its whole run, and Vitest runs the
   DB files concurrently — so `wizard-reconnect`'s cluster-wide
   `expect(databases()).toEqual(before)` saw it (reproduced 3/3). The wizard
   itself has **no** `CREATE DATABASE` capability (verified in
   `scripts/setup-neon-dev.mjs`), so the snapshot is now scoped to the
   documented sibling throwaway prefixes (`rabet_test_`, `rabet_actions_`).
   Any database the wizard could actually cause — under any other name — still
   fails the assertion, so the property under test is not weakened.

## 5. Neon identity correction

The actual Neon account configuration is: project display name **Rabet_dev**,
branch **Development**, and the real PostgreSQL database inside it is named
**`neondb`** — the display name is *not* a database name.

- `scripts/neon-dev-actions.mjs`: `EXPECTED_DEV_DB_NAME` changed from
  `"rabet_dev"` to `"neondb"`. The doc comment now states the display-name vs
  database-name distinction explicitly, so the confusion cannot recur.
- `EXPECTED_DEV_HOST` is **unchanged**:
  `ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech` (the approved DIRECT /
  unpooled endpoint). The host guard was not touched.
- Both must still match before any connection or write: the URL check in
  `validateDevUrl`, the pooled-`-pooler` refusal, and the *live* re-verification
  of `current_database()` after connecting. A different host, a pooled URL, or
  the old `rabet_dev` name now fails closed. Verified directly:
  `neondb` on the approved host → accepted; `rabet_dev` on the approved host →
  refused; `neondb` on another host → refused; `neondb` on a pooled host →
  refused.
- **No real Neon database was renamed or created**, and the real `Rabet_dev`
  URL was never used for any test.
- `tests/wizard/neon-dev-actions.test.ts`: all fixture URLs moved to `neondb`.
  The "wrong database name" case now uses `rabet_dev` — the project display
  name — as the refused value, which is exactly the plausible mistake the gate
  exists to stop. The host-mismatch case now uses an approved database name so
  the host is the *sole* reason for refusal.
- `docs/NEON_DEV_SETUP.md` §15.5: the identity table and its prose updated.

## 6. Local and CI test results

All run locally on the workspace's PostgreSQL 18 (server binaries via
`pg_config --bindir`; the suites use a disposable cluster started by
`scripts/db-test-postgres.mjs` — `initdb` on a random loopback port, trust
auth, data directory deleted on stop; never the real Neon endpoint).

| Check | Command | Result |
| --- | --- | --- |
| Runner + GitHub-guard unit tests, credential guard | `npx vitest run tests/wizard/neon-dev-actions.test.ts tests/wizard/no-committed-credentials.test.ts` | 38 passed |
| Real disposable PostgreSQL: actions runner | `node scripts/db-test-postgres.mjs run -- npx vitest run tests/db/neon-dev-actions.test.ts` | 10 passed (all 8 previously failing) |
| Same, with the exact CI `GITHUB_*` PR context injected | `… run -- env GITHUB_ACTIONS=true GITHUB_EVENT_NAME=pull_request GITHUB_REF=refs/pull/8/merge …` | 10 passed |
| Full DB suite (twice, after fix #3) | `node scripts/db-test-postgres.mjs run -- npx vitest run tests/db` | 78 passed, 2/2 runs |
| Lint | `npm run lint` | clean |
| Typecheck | `npm run typecheck` | clean |
| Full unit suite (the `verify` job's set) | `npm run test` | 203 passed, 72 skipped (DB suites skip without a cluster) |

The contaminated-environment run is the direct reproduction and proof of the
root cause: with the guard active and the harness unfiltered, those eight tests
returned `refused`; with the harness fix, they pass.

**CI:** the push that follows triggers PR #8's checks. The expected result is
both jobs green — `verify` unchanged in substance, `db` now passing 78/78. See
§8 for what to do if it is not.

## 7. Files changed

- `scripts/neon-dev-actions.mjs` — `EXPECTED_DEV_DB_NAME` → `neondb` + doc comment.
- `tests/db/neon-dev-actions.test.ts` — `cleanEnv()` isolates `GITHUB_*` (the CI fix).
- `tests/wizard/neon-dev-actions.test.ts` — fixture URLs → `neondb`; new
  `pull_request` rejection test.
- `tests/db/wizard-reconnect.test.ts` — cluster snapshot scoped to the wizard's
  own namespace (concurrency isolation).
- `docs/NEON_DEV_SETUP.md` — §15.5 identity table and prose.

Plus this file: `docs/NEON_DEV_ACTIONS_HANDOFF.md`.

## 8. Remaining tasks for Phase 03B-C2

Not started — C1 scoped the repair only.

1. **Configure the real secret.** Create the `NEON_DEV_DATABASE_URL` GitHub
   secret (prefer the `neon-dev` **environment** with deployment branches
   restricted to `main`; a repository secret works on plans without
   environments). Its value must be the **DIRECT / unpooled** connection string
   of `Rabet_dev` → branch `Development` → database `neondb`. The workflow
   never prints it. Do not configure it until you intend to run the workflow.
2. **Run the workflow by hand on `main`** (after merge), mode `inspect` first,
   and read the report: endpoint, database, PostgreSQL version, applied
   migration count, pending migrations. Confirm the live database reports
   `neondb` — the final proof the identity correction is right in production.
3. **Run mode `migrate`** with `MIGRATE_RABET_DEV` only if inspect looks right.
   The runner re-inspects and validates afterwards; the `db:check` step in CI is
   the drift gate for the committed chain.
4. **Wire the workflow into the owner's runbook** — decide whether the
   `neon-dev` environment gets a required reviewer (the workflow is already
   manual-only, concurrency-serialized, and `main`-only).
5. **Consider splitting the DB suites' concurrency** if a future suite needs a
   whole-cluster view again: the §4 fix #3 scoping is the pragmatic answer, but
   a serial `projects` lane for cluster-snapshot suites is the general one.
6. **Do not** add `push`/`pull_request`/`schedule` triggers to
   `neon-dev-migrate.yml`, wire `drizzle-kit push` anywhere, or run migrations
   from a Vercel build or at app startup.

## 9. Exact continuation instructions

```bash
cd /root/projects/rabet
git checkout feat/phase-03b-neon-dev-actions-migrations

# Confirm the state this phase left behind:
git log --oneline -6
git status --short          # clean, everything committed

# The runner's gates, no network:
npx vitest run tests/wizard/neon-dev-actions.test.ts tests/wizard/no-committed-credentials.test.ts

# The runner against real PostgreSQL (disposable cluster, never Neon):
node scripts/db-test-postgres.mjs run -- npx vitest run tests/db/neon-dev-actions.test.ts

# Full DB suite:
node scripts/db-test-postgres.mjs run -- npx vitest run tests/db

# Full unit suite (the CI `verify` job):
npm run test

# CI state of PR #8:
gh pr view 8 --repo geekammar/Rabet
gh run list --repo geekammar/Rabet --branch feat/phase-03b-neon-dev-actions-migrations --limit 3
```

If the `db` job still fails after this push, read the *shape* of the failure
first: an unexpected `refused` means a `GITHUB_*` variable is still reaching
the runner (check `cleanEnv()`); an unexpected `manual-review` in a drift test
means a previous run left a table behind (the throwaway database is created and
dropped per file, so a crashed `test:db` can leave one — stop the disposable
cluster with `node scripts/db-test-postgres.mjs stop` and re-run).

**Do not merge this PR as part of C1.** Do not run the Neon workflow, do not
configure real secrets, do not run production migrations, do not run
`pnpm ship`, do not bump versions.
