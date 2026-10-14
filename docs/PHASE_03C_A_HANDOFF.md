# Phase 03C-A1 — Recovery & Stabilization Handoff

**Purpose.** The previous OpenCode session implementing Phase 03C-A (the
server-only settings & localization data access layer) was interrupted by
context-window exhaustion **while reviewing the diff, immediately before
committing**. This session (03C-A1) recovered that work, audited it, re-verified
every claim it made, fixed what was genuinely broken, and saved this checkpoint.

It is written so the next session needs **no** access to any previous
conversation. Read `docs/DATA_MODEL.md` (the approved design),
`docs/ARCHITECTURE.md` (ADRs) and `docs/PROGRESS.md` ("What was done in
Phase 03C-A") alongside this file — the interrupted session had already updated
those documents to the implemented state, and this session re-verified that
every claim in them is true.

> **Intended reader:** the product owner reviewing the branch, and the OpenCode
> instance that continues as Phase 03C-A2.

---

## 1. Recovered Git state — exact

| Item | Value |
| --- | --- |
| Branch | `feat/phase-03c-settings-data-access` — **already correct; never recreated** |
| Base | `main` @ `8dab1432accc295c699b29e7c24d5caa1d659c` (merge of PR #8, the Neon DEV Actions runner) |
| Branch position | Exactly at the base commit — **no local commits existed yet**; all work was uncommitted |
| Modified (4) | `README.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`, `tests/db/helpers.ts` |
| Untracked (11) | `src/lib/data/{errors,index,languages,settings,templates}.ts`, `src/lib/data/__tests__/{driver-contract,errors,validation}.test.ts`, `tests/db/{settings,languages,templates}.test.ts` |

Recovery rules obeyed: no `git reset --hard`, no `git clean -fd`, no
`checkout -- .`, no rebase or pull, no force push, nothing discarded. Every
path the interrupted session was observed to have changed was still present and
was read in full before any code was written.

**No implementation, test or project-documentation file was modified by this
session.** The working tree was left exactly as the interrupted session left
it; this session only re-verified it and added this handoff document.

---

## 2. Existing files preserved — all of them

Nothing was rewritten or reorganized. In particular:

- `src/lib/data/errors.ts` (279 lines) — preserved verbatim;
- `src/lib/data/languages.ts` (335 lines) — preserved verbatim;
- `src/lib/data/settings.ts` (305 lines) — preserved verbatim;
- `src/lib/data/templates.ts` (470 lines) — preserved verbatim;
- `src/lib/data/index.ts` (47 lines) — preserved verbatim;
- the three unit-test files and the three DB-integration test files —
  preserved verbatim; **no test was deleted or weakened to obtain green
  results**;
- the four modified files — their diffs were reviewed and kept as the
  interrupted session left them.

## 3. What the interrupted session completed

The full Phase 03C-A scope, as specified, was already implemented:

**Settings (`bot_setting`).** `readSettings`, `isConfigured`, `requireSettings`,
`initializeSettings`, `updateSettings`. Explicit initialization (no invented
display name, currency or default language), `SETTINGS_ALREADY_INITIALIZED` on
re-init, singleton + currency allowlist validated in Zod and enforced by the
database's `CHECK`s, default language must exist **and** be enabled.

**Languages (`language`).** `listLanguages`, `listEnabledLanguages`,
`readLanguage`, `requireLanguage`, `ensureLanguage` (idempotent, never
overwrites), `setLanguageEnabled`, `resolveDefaultLanguage`,
`requireDefaultLanguage`. English-first behaviour, optional Arabic RTL,
translations survive disabling, the active default cannot be disabled
(`DEFAULT_LANGUAGE_REQUIRED`).

**Templates (`message_template` / `message_translation`).** `readTemplate`,
`requireTemplate`, `listTemplates`, `readTranslations`, `createTemplate`,
`updateTemplate`, `saveTranslation`, `resolveMessageText`. Stable snake_case
keys, upsert on `(template_id, language_id)`, requested → default → explicit
`missing` fallback chain, 4096-character cap in Zod **and** in the database.

**Cross-cutting.** `RabetDataError` with a closed code set, SQLSTATE-class
error mapping that walks Drizzle's `DrizzleQueryError` wrapper, safe
credential-free messages, `server-only` on every module, one injected client,
no repository framework, no `db.transaction()`, no `db.batch([...])` (no path
needs one — documented honestly in `driver-contract.test.ts`), and the
**initialization contract** that resolves Phase 03B's open seed-data decision in
favour of explicit owner values over automatic seeding.

---

## 4. Defects found

**None in the implementation, the tests, or the documentation.**

Every function was read in full and checked against `docs/DATA_MODEL.md` and
`docs/ARCHITECTURE.md`. The subtle points were verified correct:

- `updateSettings` relies on Drizzle ignoring `undefined` fields in `.set()`,
  so partial updates leave the other columns untouched — proven by the
  "writes only the provided fields" test;
- `initializeSettings` uses `ON CONFLICT DO NOTHING` on the singleton key and
  reports the conflict rather than clobbering the owner's row;
- `resolveMessageText` distinguishes "template exists, no translations" from
  "no such template" via a left join, and never fabricates a string;
- `setLanguageEnabled` re-reads `bot_setting` (not a cached settings row) for
  the default-language guard, and only when **disabling**;
- `mapDatabaseError` never builds a message from an error's own text (which
  can carry the failed SQL and parameters) and maps `23001` (RESTRICT), not
  only `23503` — the trap Phase 03B's handoff §14 item 1 warned about.

## 5. Corrections made

**None.** No file was edited, no test was weakened, no assertion was relaxed,
and no code was rewritten to make anything pass. The working tree at commit
time is byte-identical to what the interrupted session left, plus this handoff
document.

No schema or migration file was touched, and none needed to be: `drizzle-kit
check` against a freshly migrated throwaway database reports **"Everything's
fine 🐶🔥"** — no drift (§6).

---

## 6. Focused tests actually run (this session, disposable PostgreSQL only)

Every command below was executed by this session. The disposable cluster comes
from `scripts/db-test-postgres.mjs` (fresh `initdb`, random loopback port,
throwaway data directory deleted on stop). **No Neon, persistent development or
production database was contacted.**

| Command | Result |
| --- | --- |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run test` (no cluster) | ✅ **239 passed / 130 skipped**, 24 files — the DB suites skip cleanly and never fail |
| `npm run test:db` | ✅ disposable cluster → `tests/db` → cluster deleted: **11 files, 136/136 passed** |
| Focused: `tests/db/{settings,languages,templates}.test.ts` with a designated cluster | ✅ **3 files, 58/58 passed** (settings 18, languages 17, templates 23) |
| Full suite with a designated cluster (`npm run test`) | ✅ **369/369 passed, 24 files, 0 skipped** — matches the figure the interrupted session recorded in `PROGRESS.md` |
| `npm run build` with `DATABASE_URL` **unset** | ✅ exit 0; a scan of `.next/static` finds no `neondatabase`, `drizzle-orm`, `lib/data`, `server-only` or `DATABASE_URL` reference — **no data-layer or database module reaches any client bundle** |
| `npm run db:migrate` + `npm run db:check` on a throwaway database | ✅ migrations applied; **"Everything's fine 🐶🔥"** — no schema/migration drift |
| Secret scan of all changed/new files | ✅ only synthetic test fixtures (`sup3r-s3kr3t-pw`, `ep-example.neon.tech`) and documentation; `.env*` is git-ignored and nothing from `.env.local` is staged |

The three focused DB files exercise the real SQL behaviour of the singleton
`CHECK`, the currency allowlist, the text-direction rule, the
one-row-per-template-per-language unique index, the 4096-character `CHECK`,
every branch of the fallback chain, and the idempotency of initialization.

---

## 7. Remaining tasks for Phase 03C-A2

The **implementation of Phase 03C-A is complete**. A2 is the delivery slice,
mirroring the 03B-A1 → 03B-A2 pattern in `docs/PHASE_03B_HANDOFF.md`:

1. **Confirm CI is green on the pushed branch** (`.github/workflows/ci.yml`
   runs both jobs: `verify` — lint, typecheck, build, auth + unit tests; and
   `db` — an isolated `postgres:18` service container that applies the chain,
   runs `drizzle-kit check`, then `npx vitest run tests/db`, which now includes
   the three new files).
2. **Reconcile the two handoff documents**: `PROGRESS.md` currently describes
   Phase 03C-A in the state the interrupted session left it. A2 may add this
   file's recovery narrative (§1–§5) to `PROGRESS.md` or keep it here — but the
   "Verification" table in `PROGRESS.md` was re-run by this session and is
   accurate as written.
3. **Create the pull request** targeting `main` (explicitly deferred by this
   session — do **not** merge; the product owner reviews first).
4. **Product-owner review of the initialization contract** — specifically the
   still-open currency recommendation (SAR is documented as a *recommendation*
   awaiting confirmation, `DATA_MODEL.md` §19.6) and the list of template keys
   Phase 04 will need. No code change is blocked by either.
5. **Do not start Phase 04** (the settings & localization UI) until A2's PR is
   approved and merged, and never modify production configuration, run real
   Neon migrations, bump versions or deploy.

---

## 8. Files created or modified by this checkpoint

| File | Action |
| --- | --- |
| `src/lib/data/errors.ts` | new — created by the interrupted session, committed here |
| `src/lib/data/languages.ts` | new — committed here |
| `src/lib/data/settings.ts` | new — committed here |
| `src/lib/data/templates.ts` | new — committed here |
| `src/lib/data/index.ts` | new — the barrel, committed here |
| `src/lib/data/__tests__/errors.test.ts` | new — 17 tests |
| `src/lib/data/__tests__/validation.test.ts` | new — 17 tests |
| `src/lib/data/__tests__/driver-contract.test.ts` | new — 2 tests |
| `tests/db/settings.test.ts` | new — 18 DB tests |
| `tests/db/languages.test.ts` | new — 17 DB tests |
| `tests/db/templates.test.ts` | new — 23 DB tests |
| `tests/db/helpers.ts` | modified — SQLSTATE/message extraction now walks the `cause` chain (Drizzle's `DrizzleQueryError` wraps the driver error), plus the `asAppDb()` test seam that casts the `postgres-js` client to the app's `Database` type |
| `README.md` | modified — status, project structure, the data-access-layer section, the roadmap table |
| `docs/ARCHITECTURE.md` | modified — new §3.2 "Data access layer structure", testing-strategy note |
| `docs/PROGRESS.md` | modified — Phase 03C-A section: delivered surface, business rules, verification, test coverage, the initialization contract, Phase 04 prerequisites |
| `docs/PHASE_03C_A_HANDOFF.md` | new — this file |

**Not touched:** `src/db/schema/**`, `drizzle/**`, `src/db/client.ts`,
`AGENTS.md` and every route — no schema change, no migration, no UI, no new
dependency.

---

## 9. How to continue in a fresh session

```bash
cd /root/projects/rabet
git status --short              # expect: clean tree on
                                # feat/phase-03c-settings-data-access
git log --oneline -3            # the checkpoint commit is the branch tip

# Re-run the focused verification (all disposable; nothing real is contacted)
npm run lint
npm run typecheck
npm run test                    # DB suites skip without a cluster
npm run test:db                 # disposable cluster → 136 DB tests → cleanup

# Full suite including the DB suites
node scripts/db-test-postgres.mjs start
export RABET_TEST_PG_URL="$(node -e 'console.log(require("/tmp/rabet-test-pg.json").url)')"
npm run test                    # 369 tests, 0 skipped
node scripts/db-test-postgres.mjs stop
```

Then pick up §7 in order: watch CI, reconcile the handoff narrative if the owner
wants it in `PROGRESS.md`, open the PR, and stop for review.

---

## 10. Phase 03C-A2 — Verification, security review and delivery

The delivery slice. **No implementation, test or schema file was changed**; the
working tree A1 left was verified as-is. A2 re-ran every check from a clean
state on disposable PostgreSQL only, finalized the documentation, and opened the
pull request. Real Neon and Production were never contacted.

### Re-verification (all re-run by A2, disposable cluster only)

| Command | Result |
| --- | --- |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run test` (no cluster) | ✅ **239 passed / 130 skipped**, 24 files — DB suites skip cleanly |
| `npm run test:db` | ✅ disposable cluster → `tests/db` → cluster deleted: **11 files, 136/136 passed** |
| Full suite with a designated cluster (`npm run test`) | ✅ **369/369 passed, 24 files, 0 skipped** |
| `npm run build` with `DATABASE_URL` **unset** | ✅ exit 0; scan of `.next/static` and `.next/server/app` finds no `neondatabase`, `drizzle-orm`, `server-only` or `DATABASE_URL` reference |
| `npm run db:migrate` + `npm run db:check` on a throwaway database | ✅ "migrations applied successfully!" / **"Everything's fine 🐶🔥"** — no drift |
| Secret scan of the full branch diff | ✅ only synthetic test fixtures and documentation; no credentials, no `.env*` |

### Code review outcome

The full diff (`main...HEAD`, 16 files, +3424/−35) was re-read against
`docs/DATA_MODEL.md`. No defects were found; nothing was edited. The business
rules confirmed in §4 cover every item the phase requires: explicit settings
initialization, singleton behaviour, safe partial updates, the currency
allowlist, the default-language "exists **and** is enabled" constraint (§12.5),
language activation/deactivation with the `DEFAULT_LANGUAGE_REQUIRED` guard,
translation persistence across disabling, template/translation upsert
uniqueness, the English-first fallback chain with explicit `missing` results,
and idempotency at every write site.

### Security review outcome

- **Server-only confirmed** — `server-only` is imported by all five modules in
  `src/lib/data/`, and the post-build scan proves none of the layer reaches a
  client bundle.
- **No credentials in browsers** — no connection string, `DATABASE_URL` or
  driver module appears in `.next/static`.
- **No public write API** — no route was added or changed; the only existing
  API surface (`/api/admin`) already calls `requireAdmin()` at its boundary, as
  does the dashboard layout. The barrel documents that every future admin
  mutation must do the same (ADR-010).
- **No interactive transaction** — `db.transaction()` appears only in a test
  asserting it *throws* on the neon-http driver; no data-layer path uses it or
  `db.batch([...])`.
- **No automatic writes** — no module-level query and no seed execution; the
  build succeeds with `DATABASE_URL` unset, and no business row is ever
  inserted by importing the layer.
- **Authentication intact** — login and the dashboard routes build and run
  unchanged; the auth suite passes.
- **No new roles, tenants, payments or checkout** — no schema change (verified
  by `drizzle-kit check`), no new dependency, no version bump.

### Corrections made by A2

Only documentation-accuracy fixes, no code:

- `.github/workflows/ci.yml` — the `db` job's closing report now lists the
  Phase 03C-A suites (`settings`, `languages`, `templates`) it actually runs;
- `README.md` — the status block and the project-structure listing now point at
  this handoff document alongside the Phase 03B one;
- this section.

### Delivery

One pull request targeting `main` was created from this branch (see the PR link
in the final report). **It is not merged** — it waits on product-owner approval,
including the two open owner decisions of §7 item 4 (the currency choice and the
Phase 04 template-key list). Phase 04 does not start until it is approved and
merged.

**Guardrails that still apply.** Never `git reset --hard`, `git clean -fd` or
`checkout -- .` on this branch; never run `drizzle-kit push`; never migrate or
seed against anything but a disposable or explicitly designated development
database; never commit `.env*`; never add payment, invoice or order entities
(ADR-013); never run `pnpm ship` or bump the app version; and never start
Phase 04 without product-owner sign-off.
