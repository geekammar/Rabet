# Phase 02 — Authentication Security, Testing & Delivery (02B)

This document is the completion record for Phase 02. It supersedes the Phase 02A
handoff that preceded it.

- **Branch:** `feat/admin-auth`
- **Base:** `ddd525adff427ea5263e60f15b37437ca9149477` (Phase 01C merged into `main`)
- **Status:** Phase 02A and 02B complete and committed. PR opened against `main`;
  **not merged, not deployed to production, no version bumped.**

Phase 02A recovered the interrupted authentication work and committed it as a
checkpoint. Phase 02B — described below — performed the security validation,
completed the test suite, ran the audit analysis, and delivered the PR. Nothing
from Phase 02A was discarded or rewritten: every change below is additive or a
narrowly-scoped fix.

---

## 1. What Phase 02B changed

### Authentication review

The Phase 02A implementation was reviewed end to end against the mandate and
**no defect requiring a rewrite was found**. Verified properties (each confirmed
against the real production server, not only by unit test):

- Single-admin credentials verification, uniform `null` failure, one Argon2
  verification per attempt including on an unknown email (timing parity).
- Fail-closed configuration for missing, empty or non-PHC `ADMIN_PASSWORD_HASH`.
- Login, logout, session validity and expiry, dashboard protection at two layers,
  reusable `requireAdmin()` helper, unauthorized API/action access blocked.
- **CSRF enforced**: a POST without a token, or with a bogus token, is rejected
  with `MissingCSRF` and issues no session.
- **Safe redirects**: external and protocol-relative `callbackUrl` values are not
  followed off-origin. (One test initially asserted a substring absence and
  failed; investigation showed Auth.js resolves `//evil.example.com` *against the
  origin as a path*, so the navigation stays on-host — the code was correct and
  the assertion was wrong. The assertion was corrected to check the origin.)
- **Sensitive-response caching**: `/overview`, `/api/admin` and `/login` all serve
  `private, no-store` headers.
- **PWA compatibility**: the manifest, all five icons and `/favicon.ico` return
  200 while signed out, so the installed PWA can always present the login screen.
  No service worker exists; `/sw.js` and `/service-worker.js` 404.
- **No credential leakage**: the admin password, its Argon2 hash and the session
  token value never appear in any response body.

The single code change outside the test suite was the dependency
reclassification in §3.

### Test suite completion

No existing assertion was removed or weakened. The suite went from **47 to 71
tests** (5 files: 31 unit + 40 integration).

New and hardened coverage:

- **Configurable ports.** `RABET_TEST_PORT` / `RABET_TEST_PORT_2` (defaults
  3210/3211) replace the hard-coded addresses, so CI and local runs — or two runs
  side by side — never collide with `EADDRINUSE`.
- **Complete cleanup.** The throwaway env directory is removed in `afterAll`
  (previously one temp directory leaked per run), and every server the file
  spawns is tracked and reaped even when a test throws before its own `finally`.
- **Expired sessions** are now genuinely tested: the suite mints a JWT that is
  already past its `exp` using the running server's own secret and cookie name as
  the salt, then asserts `/overview` and `/api/admin` reject it. The control
  matters — the same code path minted with a positive `maxAge` is *accepted*, so
  the assertion exercises the real `exp` check rather than a malformed cookie.
- **CSRF** — missing-token and bogus-token POSTs are both rejected.
- **Open redirects** — covered on both the HTTP callback path and, for the first
  time, **through the login Server Action** (`src/app/actions/__tests__/auth.test.ts`,
  with Auth.js mocked), which is the path the `<form action={formAction}>` uses.
- **PWA assets** stay reachable while signed out; **no service worker** is
  registered; **no credential material** appears in any response body.
- **Login page cache policy** is `private, no-store`.

### Files created or modified in Phase 02B

**Modified:**

- `package.json` — `shadcn` moved from `dependencies` to `devDependencies`.
- `package-lock.json` — regenerated for that reclassification.
- `tests/auth.test.ts` — configurable ports, env-directory cleanup, server
  tracking, and the new integration coverage above. No existing assertion changed.
- `docs/ARCHITECTURE.md` — added ADR-011 (no rate limiting; what limits brute
  force instead and what to do before public access); updated the testing-strategy
  and security-considerations sections.
- `docs/PROGRESS.md` — Phase 02B verification results, security findings, and the
  automated checklist backing the manual browser checks.
- `README.md` — security posture section, configurable test ports, audit summary.

**Created:**

- `src/app/actions/__tests__/auth.test.ts` — login/logout Server Action tests.

## 2. Security audit findings and residual risks

`npm audit` reports **9 high-severity advisories**. All nine trace to a single
root package, `braces` (GHSA-vfj7-8cjw-p6xm, stack-exhaustion DoS via deeply
nested patterns), reached through `micromatch` → `fast-glob`.

| Consumer | Scope | Exposure |
| --- | --- | --- |
| `eslint-config-next` → `@next/eslint-plugin-next` | lint | dev/build only |
| `shadcn` → `@shadcn/registry`, `ts-morph` → `@ts-morph/common` | component CLI | dev/build only |

**No runtime dependency is affected** — not `next`, `next-auth`, `@auth/core`,
`@node-rs/argon2` or `zod`, and nothing in the authentication path.

**Action taken.** `shadcn` is a build-time tool (a CSS `@import` resolved at build
and a CLI); it was never imported by application runtime code. Moving it to
`devDependencies` removes `fast-glob`, `micromatch`, `braces`, `ts-morph` and
`@shadcn/registry` from the **production** dependency tree entirely. `npm ls
--omit=dev` now contains none of them. The audit count is unchanged because `npm
audit` inspects the dev tree too, but the runtime exposure is eliminated.

**Action deliberately not taken.** `npm audit fix --force` was not run. Its only
offered remediation is a breaking downgrade of the `shadcn` CLI to `1.0.0`, which
risks the toolchain for no runtime benefit — precisely the blind fix the mandate
warns against.

**Residual risk.** The advisories remain in the development tool tree. They are
exploitable only where an attacker controls input fed to a glob pattern in a lint
or codegen step, which is not the case in CI. Tracked for Phase 10.

**Brute-force mitigation.** There is no application rate limiter, and none is
claimed. The memory-hard cost of Argon2id (~20–25 ms, 19 MiB per attempt, paid on
every attempt) is the per-attempt brake; an in-process counter is explicitly
**not** shipped because it is unreliable across Vercel serverless instances.
Before internet-facing access, enable **one** of:

1. A Vercel Firewall rate-limit rule scoped to `POST /api/auth/callback/credentials`
   and `/login` — no code, no new dependency, enforced at the edge.
2. Upstash Ratelimit (or Vercel KV) applied to the same endpoints.

Until one is in place, keep **Vercel Deployment Protection enabled** so the
endpoints are not reachable from the open internet. See ADR-011.

## 3. Validation

Executed on `feat/admin-auth`. The build and tests were given a test-only
generated `AUTH_SECRET`; no real secret, password or hash was used or printed.

| Command | Result |
| --- | --- |
| `npm ci` | ✅ exit 0 — 722 packages |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 — proxy active, dashboard gated, `/` and `/login` public |
| `npm run test` | ✅ exit 0 — **5 files, 71 tests** (31 unit + 40 integration) |

Repeatability: the suite was run repeatedly, including twice consecutively and on
overridden ports (`RABET_TEST_PORT=4210 RABET_TEST_PORT_2=4211`). Every run exited
0 and left behind **no orphaned `next-server` process, no bound port, and no
`rabet-test-*` temp directory**.

### PWA and mobile validation

The development VPS has **no browser and no browser automation** (no Chromium,
Firefox, Playwright or Puppeteer is installed), so no visual or interactive check
was performed and none is claimed. What was verified over HTTP against the
production server:

- `/manifest.webmanifest` returns 200 as `application/manifest+json`, parses, and
  carries `start_url: /overview`, `scope: /`, `display: standalone` and four icons.
- All five icons and `/favicon.ico` return 200 while **signed out**.
- No service worker is registered; `/sw.js` and `/service-worker.js` return 404.
- Unauthenticated PWA entry points reach `/login`; authenticated entry reaches
  `/overview`.

The interactive checks that remain are listed in
[docs/PROGRESS.md](./PROGRESS.md) ("Remaining manual verification"). They require
the user's Android device against the Vercel preview. **None of them were claimed
as passing.**

## 4. Required manual secret provisioning

The deployment **fails closed** until these are set, by design. Provide them in
the Vercel environment variables UI for preview **and** production, and in
`.env.local` for local development. Never paste real values into chat, a commit
or a document.

1. **`AUTH_SECRET`** — the Auth.js session encryption key. Generate with
   `npx auth secret` (or `openssl rand -base64 32`). Required in every
   environment. Do not reuse a value from another project.
2. **`ADMIN_EMAIL`** — the single administrator's sign-in email.
3. **`ADMIN_PASSWORD_HASH`** — an **Argon2id PHC string**, never a plaintext
   password. Generate it on the VPS with
   `node scripts/generate-admin-hash.mjs` (it reads the password from stdin and
   prints only the hash, so the plaintext is never written or echoed) and paste
   the whole `$argon2id$…` string. A value that is not an Argon2 PHC string is
   rejected at runtime and sign-in stays disabled.

Choose a long, randomly-generated admin password. It is the only credential in the
system and there is no rate limiter yet (§2).

All three are documented with placeholders in `.env.example`. `.env*` is
git-ignored and a scan of tracked files found no real hash, secret or token.

## 5. What remains before commercial release

Phase 02 is **not** the end of release hardening. In order:

1. **Interactive verification on a real device** — the manual checklist in
   [docs/PROGRESS.md](./PROGRESS.md), ideally against the Vercel preview once the
   secrets above are provisioned on the preview environment.
2. **Provision the three secrets on Vercel preview and production** — the
   deployment fails closed until then, which is intended.
3. **A durable rate limiter** (§2) before any internet-facing access.
4. **Phase 03 — database.** Introduces the store that makes both durable session
   revocation and a durable login counter local concerns again (ADR-009, ADR-011).
5. **Phase 10 — release hardening.** Coverage thresholds, the residual dev-tooling
   advisories, and the full pre-production security pass.

## 6. Git state

```
branch:  feat/admin-auth
base:    ddd525adff427ea5263e60f15b37437ca9149477  (Phase 01C merged into main)
head:    see `git log -1`
pr:      see the PR opened against main from this branch
```

`main` was **not** modified, no manual production deployment was made, no version
number was changed, and `pnpm ship` was not run. Phase 02 is complete and ready
for review but is **not** marked Done — that decision belongs to the reviewer once
the interactive device checks are signed off.
