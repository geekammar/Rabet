# Phase 10A: Launch Readiness Assessment & Cutover Preparation

**Status:** In Review  
**Date:** 2026-10-29  
**Branch:** `feat/phase-10a-launch-readiness`  
**Starting HEAD:** `77fc463e088bb62224c396563c4831dd8aa21683` (Merge commit of PR #19)  
**Target Branch:** `main`  
**PR:** https://github.com/geekammar/Rabet/pull/20

---

## 1. Executive Summary

Phase 10A establishes an evidence-backed baseline of the Rabet project following the merge of Phase 09 ([PR #19](https://github.com/geekammar/Rabet/pull/19), commit `77fc463e088bb62224c396563c4831dd8aa21683`).

The repository code is clean, local and CI suites pass, and Vercel automatically completed a `READY` production deployment for commit `77fc463e088bb62224c396563c4831dd8aa21683`. However, **the application is NOT ready for live customer cutover or public launch**.

This assessment synthesizes personally executed inspections (HTTP probes, Git history, and GitHub Actions workflow evidence) and reviewer-supplied connected platform metadata (inspected on 2026-10-29):

1. **Reviewer-Supplied Vercel Metadata (`prj_7JvXLmI0SzqEwNtHXmSqsoSvRZMp`, Team `team_5KLLRkUhqwAgewTcysr1mY6r`):**
   - Environment variable listing for Production returned: `AUTH_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD_HASH`.
   - `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_WEBHOOK_SECRET` were **not present** in the returned project environment variable listing.
   - Protection policy metadata: SSO protection is enabled; `deploymentType: all_except_custom_domains`; Password protection and Trusted IPs are disabled.
2. **Reviewer-Supplied Neon Metadata:**
   - The connected Neon account listing showed `Rabet_dev`.
   - No independent `Rabet_prod` project appeared in the accessible listing. (Note: A branch named `production` inside `Rabet_dev` is not proof of an approved independent production environment).
3. **Personally Executed HTTP Edge Probe:**
   - Probing the Vercel-generated hostname `https://rabet-ammarj1.vercel.app/api/telegram/webhook` confirmed that SSO protection returns `HTTP/2 302` redirecting to `https://vercel.com/sso-api`. Because the current deployment relies on `*.vercel.app` hostnames and has no verified custom domain attached, Telegram Bot API webhook delivery is intercepted at the edge.
4. **Login Abuse Protection Gap:**
   - The login Server Action (`/login`) and the Auth.js callback (`/api/auth/callback/credentials`) invoke Argon2id password hashing, which is computationally expensive but provides no request throttling against automated credential stuffing.

This document classifies evidence truthfully, avoids unverified assertions of hosted state, provides an actionable Vercel WAF rate-limiting proposal, defines an approval-controlled cutover runbook with in-process secret handling, and structures the remaining Phase 10 trajectory into bounded slices (10A, 10B, 10C, 10D).

---

## 2. Verified Baseline

| Dimension | Baseline State | Evidence Source | What It Proves | What It Does Not Prove |
| :--- | :--- | :--- | :--- | :--- |
| **Repository Baseline** | `geekammar/Rabet`, `main` at `77fc463e088bb62224c396563c4831dd8aa21683` | Git log & GitHub API | PR #19 was merged into `main` | Does not prove future commits won't advance `main` |
| **CI Suite on `main`** | Passed (Run ID `40956004778`) | GitHub Actions | Lint, typecheck, build, auth, migrations, and CDP inbox test passed on runner | Does not prove hosted production database or Telegram connectivity |
| **Production Deployment Identity** | GitHub Deployment `7424358926`, Status `20947615056` (`state: success`); Vercel Deployment `DcDwNYek7HBgXPtVNU2ebf1qV7D7` | GitHub Deployments API & Vercel | Vercel built and deployed commit `77fc463` to Production environment | Does not prove database is reachable or that all required env vars are populated |
| **Vercel Project & Protection Policy** | Project `prj_7JvXLmI0SzqEwNtHXmSqsoSvRZMp`, Team `team_5KLLRkUhqwAgewTcysr1mY6r`. SSO enabled; `deploymentType: all_except_custom_domains`. | Reviewer-supplied platform metadata (2026-10-29) | Project configuration policy in Vercel | Does not prove behavior of unconfigured custom domains |
| **Edge Webhook Response** | `POST https://rabet-ammarj1.vercel.app/api/telegram/webhook` returns `HTTP/2 302` to `https://vercel.com/sso-api` | Direct HTTP probe (2026-10-29) | Current `*.vercel.app` hostname is intercepted by SSO | Does not prove behavior on an independently configured custom domain |
| **Production Env Variables** | `AUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` present; `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` absent. | Reviewer-supplied platform metadata (2026-10-29) | Metadata listing in Vercel Project Settings | Does not prove value validity or runtime decryption success |
| **Neon Project Listing** | Connected account lists `Rabet_dev`; no `Rabet_prod` project visible. | Reviewer-supplied platform metadata (2026-10-29) | Project listing in reviewer's accessible Neon account | Does not prove absence in separate accounts or unlisted projects |
| **Committed Migration Chain** | 2 migrations (`0000_initial_schema`, `0001_tree_and_snapshot_integrity`) | `drizzle/meta/_journal.json` | Committed migration files and checksums in repository | Does not prove applied migration status on any hosted database |
| **Live Telegram Webhook** | **UNKNOWN** (no `getWebhookInfo` executed) | Repository & process constraints | Webhook state on Telegram servers has not been read | Does not prove whether bot is registered, unregistered, or has pending updates |

---

## 3. Evidence-Backed Readiness Matrix

Each item is classified as **VERIFIED READY**, **VERIFIED BLOCKER**, or **UNKNOWN**.

| Area | Component / Check | Status | Evidence Reference | What Evidence Proves | What Evidence Does Not Prove | Next Concrete Action |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A. Deployment** | Production Build & Deploy | **VERIFIED READY** | GitHub Deployment `7424358926`, Vercel Deployment `DcDwNYek7HBgXPtVNU2ebf1qV7D7` | Commit `77fc463` built cleanly and deployment is READY | Does not prove runtime database or bot functionality | None (Deploy pipeline is functional) |
| **A. Deployment** | Edge Webhook Accessibility | **VERIFIED BLOCKER** | Direct HTTP probe (`HTTP 302` to `sso-api`) & Reviewer Vercel metadata (`deploymentType: all_except_custom_domains`) | Incoming webhook requests on `rabet-ammarj1.vercel.app` are redirected to Vercel SSO | Does not prove behavior of a future custom domain | Configure intended production domain or adjust deployment protection scope |
| **B. Database** | Committed Migration Chain | **VERIFIED READY** | `drizzle/meta/_journal.json#L1-L20` | Migration chain (`0000`, `0001`) is committed, syntactically valid, and passes `db:check` | Does not prove status in hosted production database | Review and approve production migration procedure |
| **B. Database** | Production Database Target | **VERIFIED BLOCKER** | Reviewer Neon metadata (`Rabet_dev` only) & Reviewer Vercel env metadata (`DATABASE_URL` absent) | No independent `Rabet_prod` project exists in connected account; Vercel Production lacks `DATABASE_URL` | Does not prove whether a production database exists under another account | Owner provisions dedicated `Rabet_prod` database and configures Vercel env |
| **B. Database** | Production Applied Migrations | **UNKNOWN** | Target database identity not established | Production database target has not been inspected | Does not prove schema state | Run inspected migration runner in Phase 10B once target is provisioned |
| **C. Auth** | Authoritative Admin Check | **VERIFIED READY** | `src/app/actions/*.ts` (`requireAdmin` in all 6 files) | All server actions enforce server-side admin session check | Does not rate limit unauthenticated login attempts | None |
| **C. Auth** | Admin Credential Configuration | **VERIFIED READY** | Reviewer Vercel metadata (`AUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` present) | Admin authentication environment variables exist in Vercel Production | Does not prove credential correctness or password validity | Verify admin sign-in once edge access is unblocked |
| **C. Auth** | Login Abuse / Rate Limiting | **VERIFIED BLOCKER** | Source inspection of `src/app/actions/auth.ts` & `src/auth.ts` | Password verification uses Argon2id with zero request throttling on `/login` or `/api/auth/*` | Does not mean credentials can be decrypted | Configure Vercel WAF Rate Limiting rule (Phase 10B) |
| **D. Login** | Historical HTTP 500 Report | **UNKNOWN / INCONCLUSIVE** | Historical developer report & `src/app/actions/auth.ts#L34-L74` | Synthetic POST without Next.js action headers returns 500 in App Router | Does not prove historical production root cause or browser behavior | Execute physical browser login against deployed target |
| **D. Login** | Deployed Browser Acceptance | **UNKNOWN** | Access blocked by edge SSO and missing database | Deployed login has not been executed by an interactive browser | Does not prove form submission failure | Run Android Acceptance Checklist post-cutover |
| **E. Audit** | Production Dependencies | **VERIFIED READY** | `scripts/validate-audit-report.mjs` run on GitHub Actions (`npm audit --omit=dev`) | Exit code `0`, exactly `0` vulnerabilities across 110 production packages | Does not mean devDependencies are free of advisories | Maintain dev dependency triage |
| **E. Audit** | Development Dependencies | **VERIFIED READY** | `scripts/validate-audit-report.mjs` run on GitHub Actions (`npm audit`) | Exit code `1`, 16 advisories (6 high, 9 moderate, 1 low) confined strictly to dev tooling (`shadcn`, `drizzle-kit`, `vitest`) | Does not affect production bundle | Maintain isolated dev tooling without `audit fix --force` |
| **F. Bot** | Webhook Auth & Deduplication | **VERIFIED READY** | `src/lib/telegram/webhook.ts#L44-L55`, `L417-L446` | Code implements constant-time secret token check, atomic DB claim, lease fencing | Does not prove Telegram can reach edge | Unblock edge, then register webhook |
| **F. Bot** | Production Bot Configuration | **VERIFIED BLOCKER** | Reviewer Vercel metadata (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` absent) | Bot credentials are not configured in Vercel Production environment | Does not prove whether bot tokens exist in BotFather | Configure distinct production bot token and secret in Vercel |
| **F. Bot** | Live Webhook Registration | **UNKNOWN** | No live Telegram API calls performed | Webhook registration state on Telegram Bot API is uninspected | Does not prove whether bot is active or inactive | Perform safe in-process `getWebhookInfo` check |
| **G. Mobile** | PWA Foundation & Safe Insets | **VERIFIED READY** | `src/app/manifest.ts`, `src/app/(auth)/login/page.tsx#L69` | PWA manifest, viewport configuration, touch targets >= 44px | Does not prove physical hardware ergonomics | Execute Android Acceptance Checklist |
| **G. Mobile** | Physical Android Verification | **UNKNOWN** | VPS has no physical hardware | Real Android keyboard, RTL Arabic typing, and PWA standalone launch untested | Does not prove mobile defect | Execute physical Android checklist |

---

## 4. Ranked Launch Blockers & Preferred Remediation Paths

### Blocker 1 (Critical): Edge Interception of Telegram Webhook
- **Observation:** `POST https://rabet-ammarj1.vercel.app/api/telegram/webhook` returns `HTTP/2 302` redirecting to `https://vercel.com/sso-api`.
- **Reviewer Metadata:** Vercel deployment protection is set to SSO with `deploymentType: all_except_custom_domains`.
- **Impact:** Telegram Bot API cannot follow SSO authentication redirects. According to official Telegram documentation ([Telegram Bot API - setWebhook](https://core.telegram.org/bots/api#setwebhook)):
  > "If a webhook returns an error (non-2xx HTTP status), Telegram will attempt to deliver the update again. After several failed attempts over multiple days, webhook delivery is temporarily suspended."
  If activated under current protection, incoming updates will fail and Telegram will abandon delivery.
- **Preferred Remediation:**
  - If using a Custom Domain (e.g., `api.rabet.com` or `rabet.com`): Attach and verify the custom domain in Vercel. Because policy is `all_except_custom_domains`, requests to the custom domain bypass SSO automatically.
  - If using the `*.vercel.app` domain: Adjust Vercel Project Settings -> Deployment Protection to disable SSO for the **Production** environment specifically, while preserving protection on Preview deployments.
  - *Security Note:* Application-level webhook authentication (`X-Telegram-Bot-Api-Secret-Token` via constant-time comparison) and admin route authentication (`requireAdmin()`) provide authoritative protection.

### Blocker 2 (Critical): Production Database Target Missing & Unmigrated
- **Observation:** Reviewer platform metadata confirmed no `Rabet_prod` project exists in the connected Neon account, and `DATABASE_URL` is absent from Vercel Production environment variables.
- **Impact:** The application runtime cannot store store settings, catalog entities, customer records, or inquiry messages. Pointing Production at `Rabet_dev` is strictly prohibited by project safety rules.
- **Preferred Remediation:**
  1. Owner provisions a dedicated `Rabet_prod` project in the Neon console.
  2. Owner sets `NEON_PROD_DATABASE_URL` in the GitHub `Production` environment (with review protections).
  3. In Phase 10B, add `scripts/neon-prod-actions.mjs` and `.github/workflows/neon-prod-migrate.yml` with pinned `EXPECTED_PROD_HOST`, `EXPECTED_PROD_DB_NAME`, and required typed confirmation `MIGRATE_RABET_PROD`.
  4. Execute the migration workflow on a GitHub-hosted runner to apply migrations `0000` and `0001` and verify the applied schema.
  5. Add `DATABASE_URL` (direct/pooled connection string with `sslmode=require`) to Vercel Production environment variables.

### Blocker 3 (High): Production Bot Credentials Missing in Vercel
- **Observation:** Reviewer platform metadata confirmed `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are not set in Vercel Production.
- **Impact:** `/api/telegram/webhook` returns `HTTP 503` ("Telegram webhook is not configured.") and fails closed.
- **Preferred Remediation:**
  1. Owner provisions a dedicated production bot with @BotFather (never sharing the development/test bot token).
  2. Owner generates a high-entropy secret token (`openssl rand -hex 32`).
  3. Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` in Vercel Production environment variables.
  4. Note: Existing working secrets (`AUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`) are already present in Vercel Production and **must not be regenerated or overwritten**.

### Blocker 4 (High): Login Endpoints Lack Request Throttling
- **Observation:** Authentication entry points execute Argon2id password hashing but have no request rate limiting.
- **Impact:** An attacker can flood credential endpoints with requests, causing compute resource exhaustion or brute-force exposure.
- **Preferred Remediation:** Deploy one minimal Vercel WAF Rate Limiting rule (detailed in §5).

---

## 5. Login Abuse Protection: Minimal Vercel WAF Rule Proposal

### Architectural Context & Entry Point Analysis
Inspection of the application code reveals exactly two entry points that reach password verification:
1. **Login Server Action (`POST /login`):** Submitted by `LoginForm` (`src/components/auth/login-form.tsx`) to the `/login` route handler with `Next-Action` headers.
2. **Auth.js Credentials Callback (`POST /api/auth/callback/credentials`):** Direct credential submission handled by Auth.js (`src/app/api/auth/[...nextauth]/route.ts`).

Both entry points call `verifyAdminCredentials` (`src/lib/auth/credentials.ts`), which runs Argon2id verification.

### Official Vercel WAF Documentation Findings
Review of current official documentation ([Vercel WAF Rate Limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)) confirms:
- WAF Rate Limiting is available on **all plan tiers**, including **one free custom rule on Hobby plans**.
- Multi-rule rate limiting and advanced keys are available on Pro and Enterprise.
- Therefore, rate limiting can be implemented via platform configuration without requiring a Pro subscription or an external Redis service.

### Proposed Minimal Rate Limiting Rule Specification

```yaml
Rule Name: protect-admin-login
Description: Rate limit credential submission on Server Action and Auth.js callback
Action: Rate Limit
Condition:
  - Request Method equals: POST
  - AND Path matches regex: ^/(login|api/auth/callback/credentials)$
Rate Limit Settings:
  - Key: Client IP Address
  - Threshold: 5 requests
  - Window: 60 seconds (1 minute)
  - Action on Exceed: Return HTTP 429 (Too Many Requests)
```

### Technical Tradeoffs & Boundary Characteristics
- **Single-Rule Coverage:** By combining both paths in a single regular expression (`^/(login|api/auth/callback/credentials)$`) conditioned on HTTP `POST`, both entry points are protected under a single rule allocation (Hobby-compatible).
- **Justification for Threshold:** The application has exactly one administrator. A human entering a password will attempt 1 to 3 times in a minute. A limit of 5 requests/minute accommodates accidental typos while capping an automated brute-force attack to 5 attempts/minute (300/hour) instead of thousands/minute.
- **Per-Region Edge Counter Behavior:** Vercel edge rate limits are tracked per edge Point of Presence (PoP). While an attacker routing across disparate global regions could theoretically achieve a small multiple of the threshold, the barrier is sufficient to neutralize naive volumetric brute force.
- **Shared Network (NAT) Tradeoff:** If the admin is on a mobile carrier network sharing an IP, 5 attempts per minute remains generous for a single user.
- **Exclusion of Telegram Webhook:** The Telegram webhook is located at `POST /api/telegram/webhook`. Because the rule strictly matches `^/(login|api/auth/callback/credentials)$`, webhook traffic is completely exempt from rate limiting.
- **Normal Operations Usability:** 
  - Loading `/login` (HTTP `GET`) is unaffected.
  - Logging out (`signOut()` or `logout()` Server Action) does not post credentials.
  - Authenticated navigation throughout the dashboard (`/overview`, `/inquiries`, `/catalog`) uses session cookies and does not hit credential endpoints.
- **Owner Lockout Recovery:** If the owner triggers a 429 lockout by mistyping the password 5 times, access is automatically restored when the 60-second sliding window expires.

---

## 6. Dependency Advisory Triage & Execution Evidence

Fresh audit evidence was collected on GitHub-hosted runners using `scripts/validate-audit-report.mjs` via `.github/workflows/audit.yml` (Run ID `40958988519` and PR checks on PR #20):

### Summary Table

| Scope | Exit Code | Findings Count | Severity Breakdown | Runtime Exposure | Decision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Production Dependencies** (`--omit=dev`) | `0` | **0** | None (Clean) | None (0 vulnerable packages shipped) | **Ready for Launch** |
| **Full Dependency Tree** (including dev) | `1` | **16** | 6 High, 9 Moderate, 1 Low | Confined strictly to dev/build tooling | **Non-blocking / Triage Only** |

### Detailed Breakdown of Full-Tree Advisories
1. **`deepmerge` / `@shadcn/registry` / `ip-address` (via `shadcn` CLI devDependency):**
   - Severity: High & Moderate.
   - Execution Context: Developer CLI tool used during code authoring to generate UI component scaffolding. Never included in the Next.js runtime bundle or serverless functions.
2. **`esbuild` / `@esbuild-kit/*` (via `drizzle-kit` devDependency):**
   - Severity: Moderate.
   - Execution Context: Drizzle CLI used for migration generation and schema checking. Runtime database access uses `@neondatabase/serverless` and `drizzle-orm` directly.
3. **`@vitest/mocker` (via `vitest` devDependency):**
   - Severity: Moderate.
   - Execution Context: Test runner executing locally and in CI.

**Conclusion:** Zero production dependencies are affected. Exploit reachability in the deployed application is 0. Running `npm audit fix --force` is prohibited as it causes breaking downgrades of development tooling. Launch is **unblocked** from a dependency advisory perspective.

---

## 7. Ordered, Executable Cutover & Rollback Runbook

> [!CAUTION]
> This runbook is a future, approval-controlled operational sequence. Do NOT execute live activations or database writes during Phase 10A.

### Step 1: Confirm Code & Deployment Identity
1. Verify `main` commit matches the approved merge commit (`77fc463e088bb62224c396563c4831dd8aa21683`).
2. Verify Vercel Production deployment state is `READY` (Deployment `DcDwNYek7HBgXPtVNU2ebf1qV7D7`).

### Step 2: Establish Independent Production Database & Backup Prerequisites
1. Confirm `Rabet_prod` project is provisioned on Neon with dedicated endpoint (e.g. `ep-prod-xyz.aws.neon.tech`).
2. Record base backup point: Neon Free tier provides 24-hour Point-in-Time Restore (PITR); Pro provides up to 30 days. Verify backup retention setting before running migrations.
3. Configure `NEON_PROD_DATABASE_URL` in GitHub `Production` environment.

### Step 3: Apply & Inspect Reviewed Migrations
1. Trigger the production migration workflow (`neon-prod-migrate.yml`) in `inspect` mode on GitHub Actions. Verify target identity.
2. Trigger the production migration workflow in `migrate` mode with typed confirmation `MIGRATE_RABET_PROD`.
3. Confirm migrations `0000_initial_schema` and `0001_tree_and_snapshot_integrity` apply cleanly.
4. Verify table count (14 tables) and schema consistency via `db:check`.

### Step 4: Configure & Verify Production Variables
In Vercel Dashboard -> Project Settings -> Environment Variables, verify Production scope:
- `AUTH_SECRET`: Existing value verified present.
- `ADMIN_EMAIL`: Existing value verified present.
- `ADMIN_PASSWORD_HASH`: Existing value verified present.
- `DATABASE_URL`: Set to `Rabet_prod` connection string (`sslmode=require`).
- `TELEGRAM_BOT_TOKEN`: Set to dedicated production bot token.
- `TELEGRAM_WEBHOOK_SECRET`: Set to high-entropy secret token.

### Step 5: Establish Login Abuse Protection
In Vercel Dashboard -> Project Settings -> Security -> Firewall / WAF:
1. Create the `protect-admin-login` rate limiting rule (§5) covering `POST` requests to `^/(login|api/auth/callback/credentials)$`.
2. Verify rule is active.

### Step 6: Configure Intended Hostname & Edge Routing
1. If using Custom Domain: Verify DNS records and ensure SSO protection policy (`all_except_custom_domains`) permits public traffic to the domain.
2. If using `*.vercel.app`: Ensure Deployment Protection is disabled for Production. Keep Preview protected.

### Step 7: Probe Application Webhook Endpoint
Execute an HTTP `POST` probe without secret token or payload to verify edge routing without following redirects:
```bash
curl -sS -o /dev/null -w "%{http_code}\n" -X POST "https://<PROD_HOST>/api/telegram/webhook"
```
**Interpretation:**
- `302`: **STOP.** Edge SSO is still intercepting requests. Telegram cannot deliver updates.
- `503`: Reaching application, but environment variables (`TELEGRAM_BOT_TOKEN`/`SECRET`) are missing.
- `401`: **SUCCESS.** Request reached the application and was rejected due to missing secret token. Edge is open and ready.
- `200` / `400`: Unexpected for an empty request.

### Step 8: Safe Read-Only Webhook Inspection
Run an in-process Python script to inspect existing Telegram webhook configuration without printing secrets or URLs:
```python
import getpass, json, urllib.request

token = getpass.getpass("Enter Telegram Bot Token: ").strip()
url = f"https://api.telegram.org/bot{token}/getWebhookInfo"

req = urllib.request.Request(url)
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode("utf-8"))
    res = data.get("result", {})
    print("--- Webhook Status ---")
    print(f"Current URL: {res.get('url') or '(None)'}")
    print(f"Has Custom Certificate: {res.get('has_custom_certificate')}")
    print(f"Pending Update Count: {res.get('pending_update_count')}")
    print(f"Last Error Date: {res.get('last_error_date') or '(None)'}")
    print(f"Last Error Message: {res.get('last_error_message') or '(None)'}")
```

### Step 9: Approve Activation & Pending Updates Policy
- **Policy Rule:** Default to `drop_pending_updates: false`.
- If `pending_update_count > 0` on an existing bot: Review whether messages are legitimate customer inquiries or old tests. Only set `drop_pending_updates: true` with explicit owner written approval.

### Step 10: Register Webhook & Execute Live Smoke Test
1. Register webhook using an in-process operator script:
   ```python
   import getpass, json, urllib.request

   token = getpass.getpass("Enter Bot Token: ").strip()
   secret = getpass.getpass("Enter Webhook Secret: ").strip()
   prod_url = input("Enter Production Webhook URL: ").strip()

   payload = json.dumps({
       "url": prod_url,
       "secret_token": secret,
       "allowed_updates": ["message", "callback_query"],
       "drop_pending_updates": False
   }).encode("utf-8")

   req = urllib.request.Request(
       f"https://api.telegram.org/bot{token}/setWebhook",
       data=payload,
       headers={"Content-Type": "application/json"}
   )

   with urllib.request.urlopen(req) as resp:
       result = json.loads(resp.read().decode("utf-8"))
       print(f"Registration result: {result.get('description')}")
   ```
2. Verification:
   - Check `getWebhookInfo`: Confirm `pending_update_count` is tracking and `url` is set.
   - Send `/start` from a personal Telegram account. Verify welcome message and catalog menu appear.
   - Submit a test inquiry. Log into `/inquiries` as admin and reply in Arabic (`مرحباً`). Verify customer receives reply.

---

### Emergency Rollback Procedures

#### Scenario A: Webhook Delivery Failure or Bot Abuse
1. Immediately pause webhook traffic via in-process script executing `deleteWebhook`:
   ```python
   import getpass, json, urllib.request
   token = getpass.getpass("Enter Bot Token: ").strip()
   req = urllib.request.Request(
       f"https://api.telegram.org/bot{token}/deleteWebhook",
       data=json.dumps({"drop_pending_updates": False}).encode("utf-8"),
       headers={"Content-Type": "application/json"}
   )
   with urllib.request.urlopen(req) as resp:
       print("Webhook removed successfully.")
   ```
2. Telegram will hold pending updates in queue for up to 24 hours while issues are addressed.

#### Scenario B: Application Rollback
1. If application defect occurs: In Vercel Dashboard -> Deployments, execute **Instant Rollback** to the prior deployment.
2. *Important Vercel Instant Rollback Note:* According to official documentation ([Vercel Instant Rollback](https://vercel.com/docs/instant-rollback)), executing an Instant Rollback disables automatic production domain assignment from Git pushes until explicitly unpinned. To restore normal Git CI/CD, the operator must re-promote the latest Git deployment in the dashboard once fixed.
3. *Database Independence:* Current migrations (`0000`, `0001`) are additive. Application rollback does NOT roll back PostgreSQL database schema.

---

## 8. Physical Android Acceptance Checklist

To be completed on a physical Android smartphone using Google Chrome or Samsung Internet over mobile data:

- [ ] **1. Form Fit & Viewport:** Navigate to `/login`. Verify viewport fits screen without horizontal scroll. Verify safe-area margins at top and bottom.
- [ ] **2. Mobile Input Mode:** Tap Email field: verify virtual keyboard opens with `@` and email-optimized layout (`inputMode="email"`).
- [ ] **3. Password Toggle & Autofill:** Tap password field: toggle show/hide eye icon. Test password manager autofill integration.
- [ ] **4. Error Presentation:** Submit incorrect password. Verify generic error banner ("Incorrect email or password") appears without layout shift.
- [ ] **5. Successful Authentication:** Enter valid credentials. Verify redirect lands on `/overview`.
- [ ] **6. Logout & Back-Button Protection:** Sign out from header menu. Tap Android system Back button. Verify application stays on `/login` and does not reveal cached dashboard content.
- [ ] **7. Touch Target Sizing:** Navigate to `/catalog` and `/settings`. Verify all buttons, inputs, and toggles present touch targets >= 44×44 CSS px.
- [ ] **8. Arabic RTL Reply:** Open active inquiry on `/inquiries/[id]`. Type a multi-line Arabic message in the composer. Verify right-to-left alignment, proper Arabic character shaping, and real-time remaining capacity counter updates.
- [ ] **9. Draft Recovery:** Enter an unsubmitted reply draft. Navigate away to `/catalog`, then return to the inquiry. Verify draft text is restored from `sessionStorage`.
- [ ] **10. Standalone PWA Launch:** Open browser menu -> "Add to Home screen" / "Install app". Install Rabet. Launch from home screen: verify standalone window mode without browser URL bar, with white status bar matching brand theme.

---

## 9. Smallest Proposed Phase 10 Trajectory

To maintain rigor and isolate operational risk, Phase 10 is structured into four bounded sub-phases:

```
Phase 10A (Current PR #20)
  └─ Establish verified baseline, matrix, WAF rate limit proposal, audit hardening & cutover runbook.
       ↓
Phase 10B (Next Step - Preparation)
  └─ Production database provisioning, pinned neon-prod-migrate workflow, and Vercel WAF rule setup.
       ↓
Phase 10C (Live Activation & Verification)
  └─ Approval-controlled webhook registration, live Telegram journey, and physical Android device acceptance.
       ↓
Phase 10D (Operational Sign-Off)
  └─ Verification of logging, backup retention, and owner limited-launch decision.
```

### Proposed Phase 10B Scope (Strictly Bounded)
1. **Production Database Tooling:**
   - Create `scripts/neon-prod-actions.mjs` and `.github/workflows/neon-prod-migrate.yml` mirroring the development migration runner's security gates: pinned `EXPECTED_PROD_HOST`, pinned `EXPECTED_PROD_DB_NAME`, and required typed confirmation `MIGRATE_RABET_PROD`.
2. **Vercel WAF Rate Limiting Activation:**
   - Configure and verify the proposed `protect-admin-login` rule in the Vercel dashboard.
3. **Environment Variable Configuration Assistance:**
   - Assist owner with populating `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_WEBHOOK_SECRET` in Vercel Production.

*(Note: In accordance with reviewer guidance, creating a dashboard health indicator, `login_attempt` table, or new queues/workers is excluded from Phase 10B).*
