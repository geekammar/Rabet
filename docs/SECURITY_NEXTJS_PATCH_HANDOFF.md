# Rabet — Security Hotfix Handoff: Next.js Patch

## 1. Problem & Official References

On October 14, 2026, Vercel disclosed multiple critical security vulnerabilities affecting Next.js 16.0.0 through 16.4.0:

1. **GHSA-2464-fhr4-w9xw / CVE-2026-96889** (Critical, CVSS 9.5):
   Unauthenticated Remote Code Execution in Image Optimization API when processing SVG files on glibc-based Linux environments (upstream `sharp` / `librsvg` vulnerability). Patched in Next.js `16.4.1` (which resolves `sharp@^0.35.5`).
2. **GHSA-673q-mjm6-r5xr** (Critical, CVSS 9.5):
   Unauthenticated Remote Code Execution in App Router with Cache Components when a `use cache` function returns typed arrays. Patched in Next.js `16.4.1`.
3. **GHSA-p3m5-59mp-jv5r** (High):
   Denial of Service in App Router applications using Server Actions from crafted requests causing excessive CPU usage. Patched in Next.js `16.4.1`.

**Official Guidance:**
- Vercel Security Blog: https://nextjs.org/blog/nextjs-security-update-october-14-2026
- GitHub Advisory: https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw

Remediation guidance requires upgrading to Next.js `16.4.1` or later. `16.4.1` was selected as the smallest compatible stable update in the 16.4 line addressing all three advisories while minimizing regression risk.

---

## 2. Base & Branch State

- **Target Repository:** `https://github.com/geekammar/Rabet`
- **Base Branch:** `origin/main`
- **Base SHA:** `bead4edce7e043c39f6f87f47072b4e0678d13bd`
- **Feature Isolation:** Work isolated in a separate git worktree at `/root/projects/rabet-security-patch` on branch `fix/nextjs-security-patch`.
- **Existing Work Protection:** Phase 04-A branch `feat/phase-04a-settings-ui` and PR #10 (`855442d1bd89b4d745c22b88624ad21f18fb7647`) were left completely untouched.

---

## 3. Dependency Changes

Aligned `next` and `eslint-config-next` to exact version `16.4.1` consistent with repository conventions:

| Dependency | Before | After | Type | Purpose |
| --- | --- | --- | --- | --- |
| `next` | `16.4.0` | `16.4.1` | Direct (`dependencies`) | Security patch for GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr, GHSA-p3m5-59mp-jv5r |
| `eslint-config-next` | `16.4.0` | `16.4.1` | Direct (`devDependencies`) | Aligned with `next` |
| `@next/env` | `16.4.0` | `16.4.1` | Transitive lockfile | Internal Next.js dependency |
| `@next/eslint-plugin-next` | `16.4.0` | `16.4.1` | Transitive lockfile | Internal ESLint plugin |
| `@next/swc-*` (all platforms) | `16.4.0` | `16.4.1` | Transitive lockfile | Native SWC compiler binaries |
| `sharp` (optional) | `^0.35.4` | `^0.35.5` | Transitive lockfile | Upstream patched image processing library |

No other dependencies were modified. React (`19.3.0`), Auth.js (`next-auth@5.0.0-beta.32`), and Drizzle ORM (`0.45.4`) remain unchanged.

---

## 4. Changed Files

1. `package.json` — updated `next` and `eslint-config-next` to `16.4.1`.
2. `package-lock.json` — updated lockfile via `npm install --package-lock-only`, cleanly verified.
3. `docs/SECURITY_NEXTJS_PATCH_HANDOFF.md` — this handoff document.

---

## 5. Verification Results

All tests and validation steps ran in an isolated environment without real database or production secrets:

| Step | Command | Result | Notes |
| --- | --- | --- | --- |
| 1. Lockfile reproducibility | `npm ci` | **Passed** | 733 packages installed cleanly |
| 2. Linting | `npm run lint` | **Passed** | ESLint 9 completed with 0 errors / 0 warnings |
| 3. Type checking | `npm run typecheck` | **Passed** | `tsc --noEmit` completed with 0 errors |
| 4. Production build | `npm run build` | **Passed** | Built without `DATABASE_URL`; 14/14 static pages generated; Cache Components and Turbopack active |
| 5. Unit & Auth test suite | `npm test` | **Passed** | 14 passed test files, 10 skipped files; 239 passed tests, 130 skipped (DB integration tests intended for DB suite), 0 failed |
| 6. DB integration test suite | `npm run test:db` | **Passed** | Ran against disposable PostgreSQL 18 cluster via `scripts/db-test-postgres.mjs`; 11 passed files, 136 passed tests, 0 failed; cluster safely destroyed |
| 7. Schema consistency | `npm run db:check` | **Passed** | `drizzle-kit check` reported schema and migrations in sync ("Everything's fine 🐶🔥") |
| 8. Local server smoke test | `npm run start` (port 3001) | **Passed** | Verified headers and redirects: <br>• `GET /` -> 200 OK (Cache HIT) <br>• `GET /login` -> 200 OK (private, no-cache, no-store) <br>• `GET /overview` -> 302 Found redirect to `/login` with `Cache-Control: private, no-store, must-revalidate; Pragma: no-cache` |

---

## 6. Dependency Audit & Triage

`npm audit --json` before vs after:

| Metric | Baseline (`16.4.0`) | Patched (`16.4.1`) | Difference |
| --- | --- | --- | --- |
| **Critical** | **1** (`next`) | **0** | **-1 (Resolved)** |
| High | 0 | 0 | 0 |
| Moderate | 7 | 7 | 0 (Unchanged dev-only) |
| Low / Info | 0 | 0 | 0 |
| **Total** | **8** | **7** | **-1** |

### Triage of Remaining Moderate Findings (DevDependencies only):
1. **`esbuild` / `@esbuild-kit/*` (via `drizzle-kit` devDependency)**
   - Severity: Moderate
   - Runtime: Local migration tooling / CLI only, never executed in production runtime.
   - Remediation: Awaiting future `drizzle-kit` release updating its internal bundler.
2. **`@vitest/mocker` (via `vitest` devDependency)**
   - Severity: Moderate
   - Runtime: Test runner only, not shipped to production.
   - Remediation: Vitest upstream patch.
3. **`ip-address` (via `shadcn` CLI devDependency)**
   - Severity: Moderate
   - Runtime: Dev component generator CLI only.
   - Remediation: Upstream shadcn CLI dependency update.

**Conclusion:** Zero critical and zero high vulnerabilities remain. No production runtime dependencies carry known vulnerabilities. Security acceptance is **UNBLOCKED**.

---

## 7. Untested Behavior & Safety Constraints

- **No Production Database or Real Neon:** By design, real database credentials were never used or contacted. Only disposable PostgreSQL was used.
- **No Production Deployment:** This hotfix is packaged strictly as a Pull Request. No Vercel production deploy or auto-merge was triggered.
- **Browser/Interactive Device Tests:** Automated HTTP integration and curl smoke tests were completed; interactive end-user browser testing remains open for manual validation on the deployed preview.

---

## 8. Next Review Steps

1. Review the Pull Request diff (`package.json`, `package-lock.json`, `docs/SECURITY_NEXTJS_PATCH_HANDOFF.md`).
2. Confirm GitHub Actions CI passes for both jobs:
   - `verify` (Lint, typecheck, build, auth + unit tests)
   - `db` (PostgreSQL service — migrations + DB integration tests)
3. Confirm Vercel Preview builds successfully.
4. **Owner Approval:** Product owner review and explicit approval required prior to merging into `main`.
