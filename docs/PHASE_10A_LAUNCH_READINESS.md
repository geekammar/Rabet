# Phase 10A: Launch Readiness Assessment & Cutover Preparation

**Status:** In Review  
**Date:** 2026-10-29  
**Branch:** `feat/phase-10a-launch-readiness`  
**Starting HEAD:** `77fc463e088bb62224c396563c4831dd8aa21683` (Merge commit of PR #19)  
**Target Branch:** `main`

---

## 1. Executive Summary

Phase 10A establishes the actual, evidence-backed baseline of the Rabet project following the merge of Phase 09 ([PR #19](https://github.com/geekammar/Rabet/pull/19)). 

The repository code is clean, all automated tests pass, and Vercel automatically completed a `READY` production deployment for commit `77fc463e088bb62224c396563c4831dd8aa21683`. However, **the application is NOT ready for live customer traffic or public launch**.

Through read-only HTTP and GitHub metadata inspections, three critical blockers were discovered:
1. **Vercel Deployment Protection is active on the Production environment**, redirecting all requests—including incoming Telegram webhooks (`POST /api/telegram/webhook`)—to Vercel SSO (`HTTP 302`), which breaks live bot communication completely.
2. **No independent Production Neon database is provisioned or migrated.** All migration workflows and secrets are strictly pinned to `Rabet_dev`.
3. **No login rate limiting exists on authentication endpoints**, leaving the Argon2id credential verification surface exposed to brute-force attacks if opened directly to the public internet.

This document provides the verified baseline, comprehensive readiness matrix, evidence citations, ranked blockers, preferred remediation paths, executable cutover runbooks, physical Android acceptance criteria, and the bounded Phase 10B proposal.

---

## 2. Verified Baseline

| Dimension | Verified State | Supporting Evidence |
| :--- | :--- | :--- |
| **Repository & Branch** | `geekammar/Rabet`, `main` at `77fc463e088bb62224c396563c4831dd8aa21683` | Git log & GitHub API |
| **PR #19 Status** | Merged into `main` by Ammar Jaber on 2026-10-29T23:13:54+02:00 | [PR #19](https://github.com/geekammar/Rabet/pull/19) |
| **CI Status (main)** | **Green (All 3 jobs passed)** in 1m 47s (Run ID `40956004778`) | GitHub Actions CI run on `77fc463e088bb62224c396563c4831dd8aa21683` |
| **Vercel Deployment** | **READY / Success** for `77fc463e088bb62224c396563c4831dd8aa21683` (Deployment ID `7424358926`) | GitHub Deployments API / Vercel Bot |
| **Production Target URL** | `https://rabet-figy1ipn9-ammarj1.vercel.app` & `https://rabet-ammarj1.vercel.app` | Vercel Deployment status & DNS |
| **Vercel Edge Protection** | **Active (SSO Redirect)**: `HTTP/2 302` to `https://vercel.com/sso-api?url=...` | Direct HTTP probe on 2026-10-29T21:30:12Z |
| **Webhook Interception** | `POST /api/telegram/webhook` returns `HTTP/2 302` to `sso-api` | Direct HTTP probe on 2026-10-29T21:30:22Z |
| **Migration Chain** | 2 applied migrations (`0000_initial_schema`, `0001_tree_and_snapshot_integrity`) | `drizzle/meta/_journal.json` |
| **Dev Database Host** | Pinned: `ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech` (`neondb`) | `scripts/neon-dev-actions.mjs` L93-L104 |
| **Production Database** | **Unprovisioned / No Actions secret** (Only `NEON_DEV_DATABASE_URL` exists) | `gh secret list` & Environment inspection |
| **Production Bot Webhook**| **Unregistered / Inactive**; zero live Telegram traffic sent | Architecture policy & source inspection |

---

## 3. Evidence-Backed Readiness Matrix

Each item is categorized as **VERIFIED READY**, **VERIFIED BLOCKER**, **UNKNOWN**, or **DEFERRED**.

| Area | Component / Check | Status | Evidence Reference | What Evidence Proves | What Evidence Does Not Prove | Next Concrete Action |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A. Deployment** | Production Deployment State | **VERIFIED READY** | GitHub Deployment `7424358926`, status `20947615056` | Commit `77fc463` built and deployed to Vercel without error | Does not prove database is reachable or that env vars are populated | None (Deploy pipeline works) |
| **A. Deployment** | Production Hostname Resolution | **VERIFIED READY** | `curl -sI https://rabet-ammarj1.vercel.app` | Host resolves to Vercel edge infrastructure | Does not prove custom domains are configured | Verify if custom domain (e.g. `rabet.com`) is required |
| **A. Deployment** | Environment Separation | **VERIFIED READY** | `scripts/neon-dev-actions.mjs#L89-L105` | Dev migration tooling refuses production hosts and pools | Does not prove Vercel dashboard environment scopes | Inspect Vercel env variable scopes in dashboard |
| **A. Deployment** | Edge Protection Policy | **VERIFIED BLOCKER** | HTTP 302 to `vercel.com/sso-api` on `/api/telegram/webhook` | Vercel Deployment Protection intercepts external webhooks | N/A | Disable Deployment Protection for Production or configure Automation Bypass |
| **B. Database** | Committed Migration Chain | **VERIFIED READY** | `drizzle/` & `drizzle/meta/_journal.json#L1-L20` | Migration chain is clean, idempotent, and passing `db:check` | Does not prove migrations are applied to production | Apply migration chain to `Rabet_prod` |
| **B. Database** | Production DB Secret in Repo | **VERIFIED BLOCKER** | `gh secret list` & `gh api /environments/Production/secrets` | GitHub Actions has no production DB secret | N/A | Add `NEON_PROD_DATABASE_URL` to GitHub `Production` environment |
| **B. Database** | Production Database Target | **UNKNOWN** | Vercel CLI logged out on VPS | Cannot inspect Vercel Production `DATABASE_URL` variable | Does not prove whether DB exists on Neon | Owner inspects Vercel env vars & Neon console |
| **B. Database** | Production Schema Migration | **VERIFIED BLOCKER** | `.github/workflows/neon-dev-migrate.yml` | No production migration runner exists in repo | N/A | Create `neon-prod-actions.mjs` and GitHub workflow in Phase 10B |
| **C. Auth** | Authoritative Admin Check | **VERIFIED READY** | `src/app/actions/*.ts` (`requireAdmin` in all 6 files) | All mutations require authenticated session | Does not prevent unauthenticated credential stuffing | None |
| **C. Auth** | Argon2id Verification | **VERIFIED READY** | `src/lib/auth/credentials.ts#L1-L79` | Memory-hard password verification, uniform error message | Does not rate limit inbound HTTP requests | None |
| **C. Auth** | Login Abuse / Rate Limiting | **VERIFIED BLOCKER** | Source inspection of `src/app/actions/auth.ts` & `src/auth.ts` | Zero request throttling on `/login` or Auth.js route | N/A | Configure Vercel WAF or implement DB rate limiter in Phase 10B |
| **D. Login** | Test Browser Acceptance | **VERIFIED READY** | CI Run `40956004778` (CDP inbox suite passed) | Auth.js credentials flow works in browser environment | Does not prove deployed production login form works | None |
| **D. Login** | Historical 500 Report | **VERIFIED READY** | `src/app/actions/auth.ts#L34-L74` | Next.js Server Actions require framework headers; raw POST fails | Proves report was synthetic request artifact, not broken code | Await real device browser acceptance |
| **D. Login** | Deployed Browser Acceptance | **UNKNOWN** | Blocked by Vercel SSO & Prod DB | Deployed login has not been executed by a real browser | N/A | Run Android Acceptance Checklist post-cutover |
| **E. Audit** | Runtime Dependency Advisories | **VERIFIED READY** | `npm audit --omit=dev` & `docs/SECURITY_NEXTJS_PATCH_HANDOFF.md` | Zero vulnerabilities in production dependencies | DevDependencies still contain moderate advisories | Maintain dev dependency triage |
| **F. Bot** | Webhook Auth & Deduplication | **VERIFIED READY** | `src/lib/telegram/webhook.ts#L44-L55`, `L417-L446` | Constant-time token check, atomic DB claim, lease fencing | Does not prove Telegram can reach edge (blocked by SSO) | Unblock edge, then register webhook |
| **F. Bot** | Bot Environment Separation | **UNKNOWN** | Vercel CLI logged out | Cannot inspect `TELEGRAM_BOT_TOKEN` in Vercel Production | Does not prove distinct bot is provisioned | Owner verifies separate test vs prod bot tokens |
| **F. Bot** | Live Webhook Registration | **UNKNOWN** | Zero live Telegram API calls performed | Webhook is not registered on live Telegram API | N/A | Run `getWebhookInfo` before registration |
| **G. Mobile** | PWA Foundation & Safe Insets | **VERIFIED READY** | `src/app/manifest.ts`, `src/app/(auth)/login/page.tsx#L69` | Manifest, icons, touch targets (>=44px), safe-area insets | Does not prove physical device rendering | Run Android Acceptance Checklist |
| **G. Mobile** | Physical Android Verification | **UNKNOWN** | VPS has no display/device | Interactive touch, autofill, Arabic IME not tested on Android | N/A | Execute physical Android checklist |

---

## 4. Ranked Launch Blockers

### Blocker 1 (Critical): Vercel Deployment Protection Intercepts Telegram Webhook
- **Observation:** `curl -sI -X POST https://rabet-ammarj1.vercel.app/api/telegram/webhook` returns `HTTP/2 302` redirecting to `https://vercel.com/sso-api`.
- **Impact:** Telegram Bot API cannot follow SSO authentication redirects. All incoming updates will fail immediately, causing Telegram to disable the webhook.
- **Root Cause:** Vercel "Deployment Protection" (Standard Vercel Authentication / SSO) is turned on globally for the project without an exception for the Production environment or webhook path.

### Blocker 2 (Critical): Production Database Unprovisioned & Unmigrated
- **Observation:** The repository only contains secrets and tooling for `Rabet_dev` (`EXPECTED_DEV_HOST = ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech`). GitHub environment `Production` has 0 secrets.
- **Impact:** If launched, the application either throws `DATABASE_URL is not set` or risks connecting to `Rabet_dev`, corrupting development data and violating environment separation rules.

### Blocker 3 (High): Production Environment Variables Unverified
- **Observation:** The VPS cannot read Vercel Production environment variables.
- **Impact:** Missing `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` triggers fail-closed "Sign-in is unavailable". Missing `AUTH_SECRET` causes Auth.js crash. Missing `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` returns HTTP 503.

### Blocker 4 (High): Login Endpoint Exposed to Unlimited Brute Force
- **Observation:** Credential verification in `src/lib/auth/credentials.ts` uses Argon2id, which consumes CPU/memory per check but has no rate-limiting barrier.
- **Impact:** If Deployment Protection is disabled to allow public bot/customer access, an attacker can flood `/login` or `/api/auth/callback/credentials` with thousands of attempts, exhausting serverless execution limits or brute-forcing the single admin password.

### Blocker 5 (Medium): Physical Android Device Acceptance Not Yet Performed
- **Observation:** CI verifies headless CDP Chromium at 360px, but physical device ergonomics, virtual keyboard behaviors, and RTL Arabic IME typing remain unverified on hardware.

---

## 5. One Preferred Remediation Path per Blocker

### Remediation 1 (Edge Protection):
- **Action:** In Vercel Project Settings -> **Deployment Protection**:
  - Keep Deployment Protection **ENABLED for Preview Deployments**.
  - Set Deployment Protection to **DISABLED for Production** (or configure a Custom Domain that bypasses protection).
  - Webhook security is strictly maintained by application-level validation: constant-time `X-Telegram-Bot-Api-Secret-Token` verification (`src/lib/telegram/webhook.ts#L44-L55`). Admin routes remain protected by `requireAdmin()`.

### Remediation 2 (Production Database):
- **Action:**
  1. Owner provisions a dedicated project `Rabet_prod` in the Neon console.
  2. Owner sets `NEON_PROD_DATABASE_URL` in GitHub `Production` environment.
  3. In Phase 10B, add `scripts/neon-prod-actions.mjs` and `.github/workflows/neon-prod-migrate.yml` with pinned `EXPECTED_PROD_HOST`, `EXPECTED_PROD_DB_NAME`, and required confirmation `MIGRATE_RABET_PROD`.
  4. Run the GitHub Action to apply migrations `0000` and `0001` with zero local VPS database execution.
  5. Set `DATABASE_URL` in Vercel Production environment variables.

### Remediation 3 (Environment Configuration):
- **Action:** Owner inspects Vercel Dashboard -> Settings -> Environment Variables and ensures all 7 required variables are populated for the **Production** environment:
  - `NEXT_PUBLIC_APP_URL` (`https://rabet-ammarj1.vercel.app` or custom domain)
  - `AUTH_SECRET` (generated via `openssl rand -base64 32`)
  - `ADMIN_EMAIL` (merchant email)
  - `ADMIN_PASSWORD_HASH` (generated via `node scripts/generate-admin-hash.mjs`)
  - `DATABASE_URL` (direct/pooled Neon connection string with `sslmode=require`)
  - `TELEGRAM_BOT_TOKEN` (production bot token from @BotFather)
  - `TELEGRAM_WEBHOOK_SECRET` (random high-entropy secret)

### Remediation 4 (Login Abuse Protection):
- **Evaluation:**
  - *Option A: Vercel WAF / Rate Limiting:* Requires Vercel Pro plan ($20/mo). Provides edge-level IP throttling before hitting serverless functions.
  - *Option B: DB-Backed Atomic Rate Limiter (Preferred for self-contained MVP):*
    Add a lightweight `login_attempt` table or query existing atomic batch primitives in PostgreSQL to track failed attempts by IP/account with a 5-attempt / 15-minute lockout window.
- **Preferred Path:** If owner has Vercel Pro, configure Vercel WAF Rate Limit rule: 5 requests/minute on `/api/auth/*`. If owner is on Vercel Hobby, implement the minimal DB-backed rate limiter in Phase 10B.

### Remediation 5 (Android Acceptance):
- **Action:** Execute the manual 10-step Android checklist below on a physical phone connected to cellular data.

---

## 6. Unknowns & Exact Missing Evidence

| Unknown Item | Why Unknown | Exact Missing Evidence | Action to Resolve |
| :--- | :--- | :--- | :--- |
| **Vercel Prod Env Vars** | Vercel CLI logged out on VPS | Output of `vercel env ls` or Vercel dashboard screenshot | Owner checks Vercel Dashboard -> Environment Variables |
| **Neon Prod Project Existence** | No production secret in repo | Neon dashboard project listing | Owner checks Neon Console for `Rabet_prod` |
| **Telegram Bot Webhook State** | No bot token provided on VPS | JSON response from `getWebhookInfo` | Owner runs sanitized `getWebhookInfo` check |
| **Vercel Plan Tier (Hobby vs Pro)** | Billing metadata not in repo | Vercel team billing settings | Owner confirms whether team is Hobby or Pro |

---

## 7. Ordered, Executable Cutover & Rollback Runbook

> [!CAUTION]
> Do NOT execute this runbook until Blockers 1, 2, and 3 are resolved. Never execute seeds against Production.

### Phase 1: Pre-Cutover Verification
1. Confirm GitHub CI run for `main` is green.
2. Confirm Vercel Production deployment is `READY`.
3. Verify Production database schema: Run `neon-prod-migrate.yml` in `inspect` mode on GitHub Actions. Verify 14 tables and 2 applied migrations.
4. Verify edge accessibility:
   ```bash
   curl -sI https://<PROD_DOMAIN>/api/telegram/webhook
   ```
   Must return `HTTP 503` (if unconfigured) or `HTTP 401` (Unauthorized), **NOT HTTP 302** to `sso-api`.

### Phase 2: Webhook State Inspection (Safe Read-Only)
Query the current webhook status using the bot token (do not print token in shell history):
```bash
read -s -p "Enter Bot Token: " BOT_TOKEN
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | jq '{url: .result.url, pending_count: .result.pending_update_count, last_error: .result.last_error_message}'
```
Record whether `pending_update_count > 0` and whether a previous URL was registered.

### Phase 3: Activation Decision on Pending Updates
- If the bot is fresh with 0 pending updates: Proceed with standard registration (`drop_pending_updates: false`).
- If stale test updates exist on the bot: Make a deliberate owner decision whether to process or set `drop_pending_updates: true`. Never drop updates silently.

### Phase 4: Webhook Registration
Register the production webhook endpoint with Telegram:
```bash
read -s -p "Enter Bot Token: " BOT_TOKEN
read -s -p "Enter Webhook Secret: " WEBHOOK_SECRET
PROD_URL="https://<PROD_DOMAIN>/api/telegram/webhook"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "'"${PROD_URL}"'",
    "secret_token": "'"${WEBHOOK_SECRET}"'",
    "allowed_updates": ["message", "callback_query"],
    "drop_pending_updates": false
  }' | jq .
```
Verify the response returns `{"ok": true, "result": true, "description": "Webhook was set"}`.

### Phase 5: Verification Smoke Test
1. Re-run `getWebhookInfo`. Confirm `url` matches `PROD_URL`, `has_custom_certificate` is `false`, and `last_error_date` is absent.
2. Open Telegram as a test customer and send `/start` to the production bot.
3. Confirm bot sends the welcome message and language selection buttons.
4. Navigate catalog to a product and tap "Ask a Question".
5. Open Seller Inbox (`https://<PROD_DOMAIN>/inquiries`), log in as admin, verify incoming inquiry appears.
6. Reply to inquiry in Arabic: `مرحباً، تم استلام استفسارك بنجاح.`
7. Verify Telegram customer receives the prefixed reply `[INQ-XXXXXX]\n\n...`.

### Phase 6: Rollback Procedure (Emergency De-activation)
If unexpected errors occur:
1. Immediately remove webhook to stop Telegram from sending traffic:
   ```bash
   read -s -p "Enter Bot Token: " BOT_TOKEN
   curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook" | jq .
   ```
2. Verify `getWebhookInfo` returns empty `url`.
3. If application code caused regression: Use Vercel Dashboard -> Deployments -> Rollback to previous deployment.
4. *Note on Database Rollback:* Database schema changes are additive and backward-compatible. Application rollback does NOT require rolling back database tables.

---

## 8. Physical Android Acceptance Checklist

To be completed on a physical Android smartphone using Google Chrome or Samsung Internet:

- [ ] **1. Sign-in Form Ergonomics:** Navigate to `/login`. Verify viewport fits screen without horizontal panning. Tap email input: verify email keyboard layout opens (`@` key accessible). Tap password input: test show/hide toggle.
- [ ] **2. Credential Rejection:** Enter wrong password. Tap "Sign in". Verify clean error banner ("Incorrect email or password") appears without leaking admin existence.
- [ ] **3. Successful Authentication:** Enter valid admin credentials. Verify seamless redirect to `/overview`.
- [ ] **4. Session Persistence & Back Button:** Tap back button on Android navigation bar. Verify application stays on `/overview` and does not revert to `/login`.
- [ ] **5. Logout Enforcement:** Open menu, tap "Sign out". Verify redirect to `/login`. Tap browser forward/back buttons; verify dashboard content cannot be viewed.
- [ ] **6. Catalog & Settings Navigation:** Log back in. Open `/catalog` and `/settings`. Verify touch targets are at least 44×44 CSS px. Verify numbers and prices display in clean decimal format.
- [ ] **7. Inbox & RTL Arabic Reply:** Open `/inquiries`. Select an active inquiry. Verify customer info card and frozen product details render cleanly. Type a multi-line Arabic reply in the composer. Verify text direction is RTL and remaining character counter updates accurately.
- [ ] **8. Draft Recovery:** Type a half-finished message. Navigate to `/overview`, then return to `/inquiries/[id]`. Verify draft text is restored from `sessionStorage`.
- [ ] **9. Delivery Presentation:** Tap "Send Reply". Verify button disables during transport and shows "Sending...". Verify status transitions to "Sent" with honest timestamps.
- [ ] **10. PWA Installation:** Open Chrome menu -> "Install app" / "Add to Home screen". Verify app icon and title "Rabet" appear. Launch from home screen: verify standalone display mode without browser address bar, with safe-area padding at top and bottom.

---

## 9. Smallest Proposed Phase 10B Scope

Phase 10B should be bounded strictly to resolving the identified release blockers without expanding product scope:

1. **Production Database Tooling (`neon-prod-migrate`):**
   - Implement `scripts/neon-prod-actions.mjs` and `.github/workflows/neon-prod-migrate.yml` mirroring the dev migration safety model: pinned production endpoint host, pinned database name, `MIGRATE_RABET_PROD` confirmation, reading secret from `Production` environment.
2. **Login Abuse Protection Implementation:**
   - Implement the selected rate limiter (Vercel WAF rule documentation or lightweight DB-backed failure counter in `src/lib/auth/credentials.ts`).
3. **Admin Health & Readiness Overview:**
   - Add a read-only health indicator in the dashboard overview that displays database connectivity and webhook configuration status to the signed-in seller.
4. **Execution of Cutover Runbook & Android Acceptance:**
   - Assist owner with controlled webhook registration, live smoke testing, and Android device sign-off.
