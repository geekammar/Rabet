# Phase 02A — Handoff

Recovery and completion of the core authentication pass. This document is the
continuation point for Phase 02B.

- **Branch:** `feat/admin-auth`
- **Base:** `ddd525adff427ea5263e60f15b37437ca9149477` (Phase 01C merged into
  `main`)
- **Status:** complete and locally committed as a checkpoint. **Not merged, no
  PR opened, not deployed.**

---

## 1. What was recovered from the interrupted session

The previous session had built essentially the whole authentication feature but
left it uncommitted on the `feat/admin-auth` branch, with the working tree dirty
and the test suite unable to run. Specifically it was:

- **Complete and correct:** `src/auth.ts`, `src/proxy.ts`,
  `src/lib/auth/*` (admin-config, credentials, session, redirect, schema,
  cache), `src/types/next-auth.d.ts`, `src/app/actions/auth.ts`,
  `src/app/api/**`, `src/app/(auth)/login/page.tsx`,
  `src/components/auth/*`, the dashboard layout auth gate, the `LogoutButton`,
  `scripts/generate-admin-hash.mjs`, `vitest.config.ts`, `tests/setup.ts`, the
  CI changes, and all 47 tests.
- **Broken but recoverable:** two lint errors and a test harness that could not
  finish a run (see §5 and §6).

Nothing was restarted from scratch. No working code was discarded. The only
source change to application code was the login form's error-state derivation
(see §2).

## 2. Files created or modified

**Modified (existing):**

- `src/components/auth/login-form.tsx` — replaced a `setState`-in-`useEffect`
  pattern (a lint error under the react-hooks ruleset) with React's documented
  "adjust state during render" pattern. Behaviour is unchanged: the generic
  error shows when a fresh action result arrives and is dismissed when the user
  edits a field.
- `tests/setup.ts` — `let snapshot` → `const` (lint).
- `tests/auth.test.ts` — the three test-harness fixes in §6. **No assertion was
  changed.**
- `src/app/(dashboard)/layout.tsx`, `src/app/page.tsx`,
  `src/components/dashboard/header.tsx`, `next.config.ts`, `tsconfig.json`,
  `package.json`, `package-lock.json`, `.github/workflows/ci.yml` — carried over
  from the interrupted session, reviewed and left as written.
- `.env.example`, `README.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md` —
  updated: the docs still described Phase 02 as "not started". Added ADR-009
  (JWT sessions and their revocation limitation) and ADR-010 (layered
  authorization), which the code comments already referenced by number.

**Created (existing from the interrupted session, now tracked):**

- `src/auth.ts`, `src/proxy.ts`, `src/lib/auth/{admin-config,cache,credentials,redirect,schema,session}.ts`,
  `src/lib/auth/__tests__/{admin-config,credentials,redirect}.test.ts`,
  `src/types/next-auth.d.ts`, `src/app/actions/auth.ts`,
  `src/app/api/admin/route.ts`, `src/app/api/auth/[...nextauth]/route.ts`,
  `src/app/(auth)/login/page.tsx`, `src/components/auth/{login-form,logout-button}.tsx`,
  `scripts/generate-admin-hash.mjs`, `tests/`, `vitest.config.ts`.
- `docs/PHASE_02_HANDOFF.md` — this file.

## 3. Authentication design choices

| Concern | Choice |
| --- | --- |
| Library | Auth.js v5 (`next-auth@5.0.0-beta.32`) — the only release line declaring Next.js 16 support |
| Provider | Credentials, email + password |
| Session | Stateless **encrypted JWT** cookie, no adapter (7-day `maxAge`) |
| Cookie | `__Secure-authjs.session-token`: `HttpOnly`, `Secure` under HTTPS, `SameSite=lax` |
| Password hash | **Argon2id** via `@node-rs/argon2` (19 MiB / 2 iterations / parallelism 1). Never plain SHA-256. |
| Admin identity | `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` env vars. Exactly one admin, no registration, no other roles. |
| Failure mode | Fail closed — missing/invalid config rejects every sign-in; no default account, no bypass |
| Authorization | Layered: optimistic `proxy.ts` redirect + authoritative `requireAdmin()` |
| Redirects | Internal allowlist (`isValidInternalRedirect`), safe fallback `/overview` |
| Caching | `private, no-store, must-revalidate` on all dashboard routes (static `next.config.ts` headers) |
| CSRF | Auth.js CSRF token on the credentials callback |
| Error surface | One generic "Incorrect email or password." for every failure — no email enumeration |

**Documented limitation:** stateless JWT sessions cannot be centrally revoked
before expiry. Logout clears the browser cookie; a stolen cookie remains valid
up to 7 days. Rotating `AUTH_SECRET` invalidates all outstanding sessions at
once. See ADR-009.

## 4. Dependencies introduced

- `next-auth@5.0.0-beta.32` — Auth.js v5.
- `@node-rs/argon2@2.2.2` — Argon2id hashing (Rust, prebuilt binary).
- `zod@4.6.5` — sign-in input validation.
- `vitest@4.1.11` (devDependency) — test runner.

No dependency was replaced or downgraded; `package-lock.json` was already
updated by the interrupted session and was left as-is.

## 5. Checks passed and failed

Executed on `feat/admin-auth` on the development VPS. The build was given a
test-only generated `AUTH_SECRET`; no real secret, password or hash was used or
printed.

| Check | Result |
| --- | --- |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 |
| `npm run test` | ✅ exit 0 — **47 tests passing** (4 files: 3 unit + 1 integration) |

The integration suite was run **twice consecutively**, both green, with no
orphaned server processes or bound ports left behind.

Known non-blocking finding carried from Phase 01: `npm audit` reports
high-severity advisories in dev-tooling transitive dependencies only
(`shadcn` registry, `ts-morph`, `eslint-config-next`), none in runtime
dependencies. Queued for Phase 10.

## 6. Known bugs and unfinished tests

No known bugs in the authentication code. Two **test-harness** bugs were found
and fixed (they were why the interrupted session's suite could not finish):

1. **Orphaned servers.** Servers are spawned as
   `bash -c "…; exec npx next start"`. Killing only the `npx` wrapper left the
   `next-server` grandchild alive, holding port 3210 and making the *next* run
   die with `EADDRINUSE`. Fixed: spawn `detached` and signal the whole process
   group, then await its exit.
2. **The suite was killing its own worker.** `freePort` used
   `lsof -i tcp:PORT`, which matches a socket by local **or remote** port. The
   test process makes outbound `fetch()` requests to the server, so it held
   client sockets whose remote port was 3210 — and `freePort` SIGKILLed the
   vitest worker itself, after every test had passed. This is why the worker
   "exited unexpectedly" only sometimes. Fixed: restrict both lookup strategies
   to `LISTEN`-state sockets (`lsof -sTCP:LISTEN`, `ss -ltnp`) and never signal
   this process or its parent. An `ss` fallback was also added because `lsof`
   silently reports nothing for listeners whose process name contains a space
   or parenthesis (`next-server (v16…)`).

**Not fixed — carried to Phase 02B:** the suite boots two real `next start`
servers and rebuilds the app on every run (~9 s). Ports 3210/3211 are
hard-coded. Neither is a correctness problem, but they should be made
configurable and the build cached.

## 7. Exact remaining tasks for Phase 02B

1. Test hardening (the Phase 02B mandate):
   - Make the integration test ports configurable (env-var override) instead of
     hard-coded 3210/3211, and skip the suite cleanly when they are in use.
   - Reuse the already-built `.next` output instead of rebuilding per run, or
     gate the build behind a `--no-build` flag for local iteration.
   - Add tests for the login Server Action's redirect validation path
     (`safeLoginRedirect`) through the actual form action, not only the
     callback URL path.
   - Consider a Vitest workspace/coverage threshold and wire `coverage` into CI.
2. Manual browser verification items listed in
   [docs/PROGRESS.md](./PROGRESS.md) ("Authentication checks") — none were
   claimed as passing; the VPS has no browser.
3. Provision the real secrets on the Vercel **preview** environment (see §8),
   then re-run the integration suite against the preview URL as a
   production-configuration smoke test.
4. Nothing in the authentication code itself is known-incomplete; if Phase 02B
   uncovers a requirement, ADR-009/ADR-010 are the place to record it.

## 8. Required manual secret provisioning (no secret values here)

The deployment **fails closed** until these are set, by design. Provide them in
the Vercel environment variables UI for preview and production, and in
`.env.local` for local development:

1. **`AUTH_SECRET`** — the Auth.js session encryption key. Generate with
   `npx auth secret` (or `openssl rand -base64 32`). Required in every
   environment.
2. **`ADMIN_EMAIL`** — the single administrator's sign-in email.
3. **`ADMIN_PASSWORD_HASH`** — an **Argon2id PHC string**, never a plaintext
   password. Generate locally with
   `node scripts/generate-admin-hash.mjs` (it reads the password from stdin and
   prints only the hash, so the plaintext is never written or echoed) and paste
   the whole `$argon2id$…` string. A value that is not an Argon2 PHC string is
   rejected at runtime and sign-in stays disabled.

All three are documented with placeholders in `.env.example`. No real secret was
generated, printed or committed during this phase, and `.env*` is git-ignored.

## 9. Git state

```
branch:  feat/admin-auth
base:    ddd525adff427ea5263e60f15b37437ca9149477  (Phase 01C merged into main)
head:    see `git log -1` — Phase 02A checkpoint commit
```

The checkpoint contains the full authentication implementation, the test harness
fixes and the documentation updates. `main` was **not** modified, no pull
request was opened, nothing was deployed, and no version was bumped.
