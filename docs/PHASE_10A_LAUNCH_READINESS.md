# Phase 10A: Launch Readiness Assessment & Cutover Preparation

**Status:** In Review  
**Date:** 2026-10-31  
**Branch:** `feat/phase-10a-launch-readiness`  
**Starting HEAD:** `77fc463e088bb62224c396563c4831dd8aa21683` (Merge commit of PR #19)  
**Target Branch:** `main`  
**PR:** https://github.com/geekammar/Rabet/pull/20

---

## 1. Executive Summary

Phase 10A establishes an evidence-backed baseline of the Rabet project following the merge of Phase 09 ([PR #19](https://github.com/geekammar/Rabet/pull/19), commit `77fc463e088bb62224c396563c4831dd8aa21683`).

The repository code is clean, local and CI suites pass, and Vercel automatically completed a `READY` production deployment for commit `77fc463e088bb62224c396563c4831dd8aa21683`. However, **the application is NOT ready for live customer cutover or public launch**.

This assessment synthesizes personally executed inspections (HTTP probes, Git history, and GitHub Actions workflow evidence) and reviewer-supplied connected platform metadata:

1. **Reviewer-Supplied Vercel Metadata (`prj_7JvXLmI0SzqEwNtHXmSqsoSvRZMp`, Team `team_5KLLRkUhqwAgewTcysr1mY6r`):**
   - Environment variable listing for Production returned: `AUTH_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD_HASH`.
   - `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_WEBHOOK_SECRET` were **not present** in the returned project environment variable listing.
   - Protection policy metadata: SSO protection is enabled; `deploymentType: all_except_custom_domains`; Password protection and Trusted IPs are disabled.
2. **Reviewer-Supplied Neon Metadata:**
   - The connected Neon account listing showed `Rabet_dev`.
   - No independent `Rabet_prod` project appeared in the accessible listing. Target database identity is not established, and applied schema state is UNKNOWN. (Note: A branch named `production` inside `Rabet_dev` is not proof of an approved independent production environment).
3. **Personally Executed HTTP Edge Probe:**
   - Probing the Vercel-generated hostname `https://rabet-ammarj1.vercel.app/api/telegram/webhook` confirmed that SSO protection returns `HTTP/2 302` redirecting to `https://vercel.com/sso-api`. Because the current deployment relies on `*.vercel.app` hostnames and has no verified custom domain attached, Telegram Bot API webhook delivery is intercepted at the edge.
4. **Login Abuse Protection Gap:**
   - The login Server Action (`/login`) and the Auth.js callback (`/api/auth/callback/credentials`) invoke Argon2id password hashing, which is computationally expensive but provides no request throttling against automated credential stuffing.

This document classifies evidence truthfully, avoids unverified assertions of hosted state, provides an actionable Vercel WAF rate-limiting proposal, defines an approval-controlled cutover runbook with in-process secret handling and sanitized exception handling, and structures the remaining Phase 10 trajectory into bounded slices (10A, 10B, 10C, 10D).

---

## 2. Verified Baseline

| Dimension | Baseline State | Evidence Source | What It Proves | What It Does Not Prove |
| :--- | :--- | :--- | :--- | :--- |
| **Repository Baseline** | `geekammar/Rabet`, `main` at `77fc463e088bb62224c396563c4831dd8aa21683` | Git log & GitHub API | PR #19 was merged into `main` | Does not prove future commits won't advance `main` |
| **CI Suite on `main`** | Passed (Run ID `40956004778`) | GitHub Actions | Lint, typecheck, build, auth, migrations, and CDP inbox test passed on runner | Does not prove hosted production database or Telegram connectivity |
| **Production Deployment Identity** | GitHub Deployment `7424358926`, Status `20947615056` (`state: success`); Vercel Deployment `DcDwNYek7HBgXPtVNU2ebf1qV7D7` | GitHub Deployments API & Vercel | Vercel built and deployed commit `77fc463` to Production environment | Does not prove database is reachable or that all required env vars are populated |
| **Vercel Project & Protection Policy** | Project `prj_7JvXLmI0SzqEwNtHXmSqsoSvRZMp`, Team `team_5KLLRkUhqwAgewTcysr1mY6r`. SSO enabled; `deploymentType: all_except_custom_domains`. | Reviewer-supplied platform metadata | Project configuration policy in Vercel | Does not prove behavior of unconfigured custom domains |
| **Edge Webhook Response** | `POST https://rabet-ammarj1.vercel.app/api/telegram/webhook` returns `HTTP/2 302` to `https://vercel.com/sso-api` | Direct HTTP probe | Current `*.vercel.app` hostname is intercepted by SSO | Does not prove behavior on an independently configured custom domain |
| **Production Env Variables** | `AUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` present; `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` absent. | Reviewer-supplied platform metadata | Metadata listing in Vercel Project Settings | Does not prove value validity or runtime decryption success |
| **Neon Project Listing** | Connected account lists `Rabet_dev`; no `Rabet_prod` project visible. | Reviewer-supplied platform metadata | Project listing in reviewer's accessible Neon account | Does not prove absence in separate accounts or unlisted projects |
| **Committed Migration Chain** | 2 migrations (`0000_initial_schema`, `0001_tree_and_snapshot_integrity`) | `drizzle/meta/_journal.json` | Committed migration files and checksums in repository | Does not prove applied migration status on any hosted database |
| **Live Telegram Webhook** | **UNKNOWN** (no `getWebhookInfo` executed) | Repository & process constraints | Webhook state on Telegram servers has not been read | Does not prove whether bot is registered, unregistered, or has pending updates |

---

## 3. Evidence-Backed Readiness Matrix

Each item is classified as **VERIFIED READY**, **VERIFIED BLOCKER**, or **UNKNOWN**.

| Area | Component / Check | Status | Evidence Reference | What Evidence Proves | What Evidence Does Not Prove | Next Concrete Action |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A. Deployment** | Production Build & Deploy | **VERIFIED READY** | GitHub Deployment `7424358926`, Vercel Deployment `DcDwNYek7HBgXPtVNU2ebf1qV7D7` | Commit `77fc463` built cleanly and deployment is READY | Does not prove runtime database or bot functionality | None (Deploy pipeline is functional) |
| **A. Deployment** | Edge Webhook Accessibility | **VERIFIED BLOCKER** | Direct HTTP probe (`HTTP 302` to `sso-api`) & Reviewer Vercel metadata (`deploymentType: all_except_custom_domains`) | Incoming webhook requests on `rabet-ammarj1.vercel.app` are redirected to Vercel SSO | Does not prove behavior of a future custom domain | Configure intended production domain or adjust deployment protection scope |
| **B. Database** | Committed Migration Chain | **VERIFIED READY** | `drizzle/meta/_journal.json#L1-L20` | Migration chain (`0000`, `0001`) is committed, syntactically valid, and passes `db:check` locally | Does not prove status in hosted production database | Review and approve production migration procedure |
| **B. Database** | Production Database Target | **VERIFIED BLOCKER** | Reviewer Neon metadata (`Rabet_dev` only) & Reviewer Vercel env metadata (`DATABASE_URL` absent) | No independent `Rabet_prod` project exists in connected account; Vercel Production lacks `DATABASE_URL` | Does not prove whether a production database exists under another account | Owner provisions dedicated `Rabet_prod` database and configures Vercel env |
| **B. Database** | Production Applied Migrations | **UNKNOWN** | Target database identity not established | Production database target has not been inspected; applied schema state is UNKNOWN | Does not prove schema state on uninspected target | Run inspected migration runner in Phase 10B once target is provisioned |
| **C. Auth** | Authoritative Admin Check | **VERIFIED READY** | `src/app/actions/*.ts` (`requireAdmin` in protected mutation files) | Protected business mutations enforce admin authorization via `requireAdmin` (public login action is an intentional unauthenticated entry point) | Does not rate limit unauthenticated login attempts | None |
| **C. Auth** | Admin Credential Configuration | **VERIFIED READY** | Reviewer Vercel metadata (`AUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` present) | Admin authentication environment variables exist in Vercel Production | Does not prove credential correctness or password validity | Verify admin sign-in once edge access is unblocked |
| **C. Auth** | Login Abuse / Rate Limiting | **VERIFIED BLOCKER** | Source inspection of `src/app/actions/auth.ts` & `src/auth.ts` | Password verification uses Argon2id with zero request throttling on `/login` or `/api/auth/*` | Does not mean credentials can be decrypted | Configure Vercel WAF Rate Limiting rule (Phase 10B) |
| **D. Login** | Historical HTTP 500 Report | **UNKNOWN / INCONCLUSIVE** | Historical developer report & `src/app/actions/auth.ts#L34-L74` | Synthetic POST without Next.js action headers returns 500 in App Router | Does not prove historical production root cause or browser behavior | Execute physical browser login against deployed target |
| **D. Login** | Deployed Browser Acceptance | **UNKNOWN** | Access blocked by edge SSO and missing database | Deployed login has not been executed by an interactive browser | Does not prove form submission failure | Run Android Acceptance Checklist post-cutover |
| **E. Audit** | Production Dependencies | **VERIFIED READY** | `scripts/validate-audit-report.mjs` run on GitHub Actions (`npm audit --omit=dev`) | Exit code `0`, 0 advisories reported by the production dependency audit at that commit/time | Does not mean devDependencies are free of advisories | Maintain dev dependency triage |
| **E. Audit** | Development Dependencies | **VERIFIED READY** | `scripts/validate-audit-report.mjs` run on GitHub Actions (`npm audit`) | Exit code `1`, 34 advisories (6 high, 27 moderate, 1 low, 0 critical) recorded at commit `2317eae` (run `41249425002`); historical 16-finding baseline preserved; exploit reachability has not been demonstrated | Does not affect production bundle | Maintain isolated dev tooling without `audit fix --force` |
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
- **Impact:** Telegram Bot API cannot follow SSO authentication redirects. According to official Telegram Bot API documentation ([Telegram Bot API - setWebhook](https://core.telegram.org/bots/api#setwebhook)):
  If a webhook endpoint returns a non-2xx HTTP status, Telegram repeats the delivery request and will give up after a reasonable number of attempts. Furthermore, if all requests to the webhook continuously return HTTP 410 Gone for more than 23 hours successively, the Bot API automatically deletes the webhook integration. Because current edge SSO returns HTTP 302 redirects, Telegram cannot complete delivery and will abandon incoming updates.
- **Preferred Remediation:**
  - If using a Custom Domain (e.g., `api.rabet.com` or `rabet.com`): Attach and verify the custom domain in Vercel. Because policy is `all_except_custom_domains`, requests to the custom domain bypass SSO automatically.
  - If using the `*.vercel.app` domain: Adjust Vercel Project Settings -> Deployment Protection to disable SSO for the **Production** environment specifically, while preserving protection on Preview deployments.
  - *Security Note:* Application-level webhook authentication (`X-Telegram-Bot-Api-Secret-Token` via constant-time comparison) and admin route authorization (`requireAdmin()`) provide authoritative protection.

### Blocker 2 (Critical): Production Database Target Unconfigured & Applied Schema Unknown
- **Observation:** Reviewer platform metadata confirmed no `Rabet_prod` project exists in the connected Neon account, and `DATABASE_URL` is absent from Vercel Production environment variables. Target database identity is not established, and applied schema state is UNKNOWN.
- **Impact:** The application runtime cannot store store settings, catalog entities, customer records, or inquiry messages. Pointing Production at `Rabet_dev` is strictly prohibited by project safety rules.
- **Preferred Remediation:**
  1. Owner provisions a dedicated `Rabet_prod` project in the Neon console.
  2. Owner sets `NEON_PROD_DATABASE_URL` in the GitHub `Production` environment (with review protections).
  3. In Phase 10B, add `scripts/neon-prod-actions.mjs` and `.github/workflows/neon-prod-migrate.yml` with pinned `EXPECTED_PROD_HOST`, `EXPECTED_PROD_DB_NAME`, and required typed confirmation `MIGRATE_RABET_PROD`.
  4. Execute the migration workflow on a GitHub-hosted runner to apply migrations `0000` and `0001` and verify the applied schema ledger and tables directly.
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
- **Preferred Remediation:** Document one minimal Vercel WAF Rate Limiting rule (detailed in §5) for Phase 10B deployment.

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
- **Fixed-Window Algorithm & Burst Characteristics:** Vercel WAF evaluates rate limiting via a **fixed-window algorithm**, not a sliding window. With a fixed 60-second window, requests arriving across window boundaries can allow brief boundary bursts (e.g., up to 10 attempts if 5 occur near the end of minute 1 and 5 occur at the start of minute 2).
- **Per-Region Edge Counter Behavior:** Vercel edge rate limits are tracked per edge Point of Presence (PoP) / region. An adversary rotating client IPs or distributing requests across global regions could achieve multiples of the threshold. Therefore, this rule is **proportionate initial protection** against naive volumetric brute-force attacks, not complete brute-force or bot protection.
- **Shared Network (NAT) Tradeoff:** If the admin is on a mobile carrier network sharing an IP, 5 attempts per 60 seconds remains generous for a single human user.
- **Exclusion of Telegram Webhook:** The Telegram webhook is located at `POST /api/telegram/webhook`. Because the rule strictly matches `^/(login|api/auth/callback/credentials)$`, webhook traffic is completely exempt from rate limiting.
- **Normal Operations Usability:** 
  - Loading `/login` (HTTP `GET`) is unaffected.
  - Logging out (`signOut()` or `logout()` Server Action) does not post credentials.
  - Authenticated navigation throughout the dashboard (`/overview`, `/inquiries`, `/catalog`) uses session cookies and does not hit credential endpoints.
- **Owner Lockout Recovery:** If the owner triggers a 429 lockout by mistyping the password 5 times, access is automatically restored once the active 60-second fixed window expires.
- **Operational Status:** This rule is documented here as an approved proposal for Phase 10B. It is **NOT** published or deployed during Phase 10A.

---

## 6. Dependency Advisory Triage & Execution Evidence

Audit evidence was verified on GitHub-hosted runners using `scripts/validate-audit-report.mjs` via `.github/workflows/audit.yml` for commit `2317eae37f1a7c14de1da602f97d5caef2a0c7d8` ([Run 41249425002](https://github.com/geekammar/Rabet/actions/runs/41249425002), executed 2026-10-31 22:44 UTC):

### Summary Table

| Scope | Exit Code | Findings Count | Severity Breakdown | Runtime Exposure | Decision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Production Dependencies** (`--omit=dev`) | `0` | **0** | None (Clean) | No advisories reported by the production dependency audit at that commit/time | **Ready for Launch** |
| **Full Dependency Tree** (including dev) | `1` | **34** | 6 High, 27 Moderate, 1 Low, 0 Critical | Full-tree findings are present in tooling paths; exploit reachability has not been demonstrated | **Non-blocking / Triage Only** |

*(Historical baseline note: An earlier audit execution on commit `c3218e4`, run `40958988519`, reported 16 advisories [6 High, 9 Moderate, 1 Low]. The subsequent shift to 34 advisories reflects newly published upstream CVE database entries in the public npm registry affecting existing transitive dev dependencies—primarily under `drizzle-kit` / `esbuild` and `shadcn` CLI tooling—rather than changes in the application bundle or additions of new packages. Tooling advisory counts in public registries fluctuate over time and do not imply exploit reachability).*

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

**Conclusion:** No advisories are reported by the production dependency audit (`npm audit --omit=dev`) at this commit and time. Full-tree findings are present in development tooling paths (`shadcn`, `drizzle-kit`, `vitest`); exploit reachability in the deployed application has not been demonstrated, nor does an advisory report alone prove exploitability. Running `npm audit fix --force` is prohibited as it causes breaking downgrades of development tooling. Launch is **unblocked** from a dependency advisory perspective.

---

## 7. Ordered, Executable Cutover & Rollback Runbook

> [!CAUTION]
> This runbook is a future, approval-controlled operational sequence. Do NOT execute live activations or database writes during Phase 10A.

### Step 1: Confirm Code & Deployment Identity
1. At actual future execution time, resolve the newly approved `main` commit identity (e.g. `git rev-parse origin/main` or the approved release PR merge commit). Do not assume a pre-PR20 commit is the only valid release.
2. Verify that the corresponding Vercel Production deployment state is `READY` in the Vercel Dashboard or Deployments API.

### Step 2: Establish Independent Production Database & Backup Prerequisites
1. Confirm `Rabet_prod` project is provisioned on Neon with dedicated endpoint (e.g. `ep-prod-xyz.aws.neon.tech`).
2. **Backup & Retention Verification:**
   - Official Neon documentation specifies a **6-hour history retention window** (`history_retention_seconds = 21600`) for the Free plan, capped at 1 GB of WAL change history. Paid plans support configurable retention up to 30 days.
   - **Requirement:** Inspect the actual future Production project's plan, `history_retention_seconds`, restore capability, and limits before executing migrations. Do NOT substitute DEV metadata or plan assumptions for Production guarantees.
3. **Concrete Pre-Migration Recovery Checkpoint:**
   - Prior to applying migrations to `Rabet_prod`, record the pre-migration timestamp/LSN or create an explicit pre-migration branch checkpoint in Neon (e.g., `pre-migration-checkpoint-YYYYMMDD-HHMMSS`).
4. **Safe Approved Restoration Procedure:**
   - If a migration fails or schema corruption occurs, the approved recovery procedure is to reset the production compute endpoint to the pre-migration branch checkpoint or restore the project to the recorded timestamp via the Neon Console/API, then verify connection and table integrity. (Do not execute during Phase 10A).
5. Configure `NEON_PROD_DATABASE_URL` in GitHub `Production` environment.

### Step 3: Apply & Inspect Reviewed Migrations
> [!IMPORTANT]
> A repository `db:check` validates committed migrations against local Drizzle schema definitions, but does NOT prove hosted migrations were applied. Require target inspection and migration-ledger/schema evidence separately.

1. Trigger the production migration workflow (`neon-prod-migrate.yml`) in `inspect` mode on GitHub Actions: verify connectivity and query the `drizzle.__drizzle_migrations` ledger table to determine applied migration records.
2. Trigger the production migration workflow in `migrate` mode with typed confirmation `MIGRATE_RABET_PROD` to execute `drizzle-kit migrate`.
3. Confirm migrations `0000_initial_schema` and `0001_tree_and_snapshot_integrity` apply cleanly.
4. Verify target database ledger and schema: query `drizzle.__drizzle_migrations` to confirm records for `0000_initial_schema` and `0001_tree_and_snapshot_integrity`, and query `information_schema.tables` to confirm all 14 application tables exist.

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
Run an in-process Python script to inspect existing Telegram webhook configuration.
- Secrets stay in process and are entered with `getpass`.
- Never prints token-bearing API URLs or raw exception/response bodies.
- Sets finite network timeouts.
- Handles transport, HTTP, JSON, and API failures with fixed sanitized errors.
- Validates the response root and `ok`/`result` fields; exits non-zero on failure.
- Sanitizes displayed endpoint (origin and path only; query parameters redacted).
- Does NOT return the secret token; privately records existing settings for potential restoration.

```python
import getpass
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

token = getpass.getpass("Enter Telegram Bot Token: ").strip()
if not token:
    print("Error: Bot token cannot be empty.", file=sys.stderr)
    sys.exit(1)

req = urllib.request.Request(
    f"https://api.telegram.org/bot{token}/getWebhookInfo",
    headers={"User-Agent": "Rabet-Operator/1.0"}
)

try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = resp.read().decode("utf-8")
except urllib.error.HTTPError as e:
    print(f"Inspection failed: Telegram API returned HTTP status {e.code}.", file=sys.stderr)
    sys.exit(1)
except urllib.error.URLError:
    print("Inspection failed: Network transport error or timeout connecting to Telegram Bot API.", file=sys.stderr)
    sys.exit(1)
except Exception:
    print("Inspection failed: Unexpected system or I/O error during request execution.", file=sys.stderr)
    sys.exit(1)

try:
    data = json.loads(body)
except Exception:
    print("Inspection failed: Response payload is not valid JSON.", file=sys.stderr)
    sys.exit(1)

if not isinstance(data, dict) or data.get("ok") is not True or not isinstance(data.get("result"), dict):
    print("Inspection failed: Telegram API returned error or unexpected response structure.", file=sys.stderr)
    sys.exit(1)

res = data["result"]
raw_url = res.get("url") or ""

# Sanitize URL for display (redact query strings or tokens that might be in parameters)
if raw_url:
    parsed = urllib.parse.urlsplit(raw_url)
    display_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    if parsed.query:
        display_url += "?<redacted-query-parameters>"
else:
    display_url = "(None - Webhook not set / using polling)"

print("=== Telegram Webhook Status ===")
print(f"Sanitized Endpoint:     {display_url}")
print(f"Has Custom Certificate: {res.get('has_custom_certificate')}")
print(f"Pending Update Count:   {res.get('pending_update_count', 0)}")
print(f"Max Connections:        {res.get('max_connections', 40)}")
print(f"Allowed Updates:        {res.get('allowed_updates', [])}")
print(f"Last Error Date:        {res.get('last_error_date', '(None)')}")
print(f"Last Error Message:     {res.get('last_error_message', '(None)')}")
print(f"Last Sync Error Date:   {res.get('last_synchronization_error_date', '(None)')}")

# Operator note: getWebhookInfo NEVER returns the secret_token.
# Record exact prior URL and allowed_updates in secure operator notes before altering configuration.
```

### Step 9: Approve Activation & Pending Updates Policy
- **Policy Rule:** Default to `drop_pending_updates: false`.
- If `pending_update_count > 0` on an existing bot: Review whether messages are legitimate customer inquiries or old tests. Only set `drop_pending_updates: true` with explicit written owner approval.

### Step 10: Register Webhook & Execute Live Smoke Test
1. Register webhook using an in-process operator script:
   - Validates the proposed endpoint against the intended approved hostname and path (`/api/telegram/webhook`).
   - Handles transport, HTTP, JSON, and API failures with fixed sanitized errors.
   - Sets a finite network timeout (15s).
   - Validates that `ok === true` and `result === true`.
   - **Do not automatically retry an ambiguous write.** If a network timeout or transport failure occurs, perform a read-only `getWebhookInfo` status inspection to determine the actual state before deciding whether another write is appropriate.
   - Immediately queries `getWebhookInfo` to verify that the reported URL exactly matches the intended approved URL, confirms the expected `allowed_updates` set (`{"message", "callback_query"}`), and checks pending update counts.
   - **Every failed post-registration inspection exits non-zero (`sys.exit(1)`).**
   - Distinguishes initial registration acknowledgement from configuration verification.
   - Does not claim live delivery from configuration inspection alone (live test messages in Step 10.2 are required).

```python
import getpass
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

APPROVED_HOST = "api.rabet.example.com"  # Replace with actual approved production domain
APPROVED_PATH = "/api/telegram/webhook"

token = getpass.getpass("Enter Bot Token: ").strip()
secret = getpass.getpass("Enter Webhook Secret: ").strip()
prod_url = input("Enter Production Webhook URL: ").strip()

if not token or not secret or not prod_url:
    print("Error: Bot token, webhook secret, and URL are all required.", file=sys.stderr)
    sys.exit(1)

# Validate URL against approved production hostname and path
parsed = urllib.parse.urlsplit(prod_url)
if parsed.scheme != "https":
    print("Error: Webhook URL must use HTTPS scheme.", file=sys.stderr)
    sys.exit(1)
if parsed.netloc != APPROVED_HOST or parsed.path != APPROVED_PATH:
    print(f"Error: Webhook target '{parsed.netloc}{parsed.path}' does not match approved endpoint '{APPROVED_HOST}{APPROVED_PATH}'.", file=sys.stderr)
    sys.exit(1)

payload = json.dumps({
    "url": prod_url,
    "secret_token": secret,
    "allowed_updates": ["message", "callback_query"],
    "drop_pending_updates": False  # Preserved by default; dropping requires explicit owner approval
}).encode("utf-8")

req = urllib.request.Request(
    f"https://api.telegram.org/bot{token}/setWebhook",
    data=payload,
    headers={
        "Content-Type": "application/json",
        "User-Agent": "Rabet-Operator/1.0"
    }
)

try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = resp.read().decode("utf-8")
except urllib.error.HTTPError as e:
    print(f"Registration failed: Telegram API returned HTTP status {e.code}.", file=sys.stderr)
    sys.exit(1)
except urllib.error.URLError:
    print("Ambiguous result: Network transport error or timeout during setWebhook request.", file=sys.stderr)
    print("DO NOT automatically retry writes. Run getWebhookInfo inspection to verify current server state.", file=sys.stderr)
    sys.exit(1)
except Exception:
    print("Ambiguous result: Unexpected system or I/O error during request execution.", file=sys.stderr)
    print("Run getWebhookInfo inspection to verify current server state.", file=sys.stderr)
    sys.exit(1)

try:
    data = json.loads(body)
except Exception:
    print("Registration failed: Telegram API returned malformed non-JSON response.", file=sys.stderr)
    sys.exit(1)

if not isinstance(data, dict) or data.get("ok") is not True or data.get("result") is not True:
    print("Registration failed: setWebhook was rejected or returned non-true result.", file=sys.stderr)
    sys.exit(1)

# Immediate post-registration verification:
print("Webhook registration acknowledged by Telegram Bot API (ok: true, result: true).")
print("Executing read-only configuration verification via getWebhookInfo...")

verify_req = urllib.request.Request(
    f"https://api.telegram.org/bot{token}/getWebhookInfo",
    headers={"User-Agent": "Rabet-Operator/1.0"}
)

try:
    with urllib.request.urlopen(verify_req, timeout=15) as vresp:
        vbody = vresp.read().decode("utf-8")
except urllib.error.HTTPError as e:
    print(f"Verification failed: Telegram API returned HTTP status {e.code}.", file=sys.stderr)
    print("Registration was acknowledged, but verification inspection failed. Run getWebhookInfo separately to reconcile state.", file=sys.stderr)
    sys.exit(1)
except urllib.error.URLError:
    print("Verification failed: Network transport error or timeout during post-registration inspection.", file=sys.stderr)
    print("Registration was acknowledged, but current server configuration could not be verified.", file=sys.stderr)
    print("DO NOT retry setWebhook blindly. Run a read-only getWebhookInfo inspection to reconcile state.", file=sys.stderr)
    sys.exit(1)
except Exception:
    print("Verification failed: Unexpected system or I/O error during post-registration inspection.", file=sys.stderr)
    print("Run a read-only getWebhookInfo inspection to reconcile state.", file=sys.stderr)
    sys.exit(1)

try:
    vdata = json.loads(vbody)
except Exception:
    print("Verification failed: Inspection response payload is not valid JSON.", file=sys.stderr)
    sys.exit(1)

if not isinstance(vdata, dict) or vdata.get("ok") is not True or not isinstance(vdata.get("result"), dict):
    print("Verification failed: getWebhookInfo returned error or unexpected response structure.", file=sys.stderr)
    sys.exit(1)

vres = vdata["result"]

# 1. Require exact URL equality with approved submitted endpoint
if vres.get("url") != prod_url:
    print("Verification failed: Reported webhook URL does not match submitted approved URL.", file=sys.stderr)
    sys.exit(1)

# 2. Require expected allowed_updates set
expected_updates = {"message", "callback_query"}
reported_updates = set(vres.get("allowed_updates") or [])
if reported_updates != expected_updates:
    print(f"Verification failed: Reported allowed_updates ({sorted(reported_updates)}) do not match expected ({sorted(expected_updates)}).", file=sys.stderr)
    sys.exit(1)

print("Configuration verified: Webhook target URL and allowed updates confirmed on Telegram Bot API.")
print(f"Pending updates count: {vres.get('pending_update_count', 0)}")
print("Note: Configuration inspection verifies endpoint registration only; live update delivery must be validated via actual test messages in Step 10.2.")
```

2. Smoke Test Verification:
   - Send `/start` from a personal Telegram account. Verify welcome message and catalog menu appear.
   - Submit a test inquiry. Log into `/inquiries` as admin and reply in Arabic (`مرحباً`). Verify customer receives reply.

---

### Emergency Rollback Procedures

#### Scenario A: Webhook Emergency Pause (`deleteWebhook`)
1. Immediately pause webhook traffic via in-process script executing `deleteWebhook`:
   - Validates that `ok === true` and `result === true`.
   - Never prints secrets or token URLs.
   - Handles transport and API errors with sanitized errors.
   - Preserves pending updates by default (`drop_pending_updates: False`). Dropping pending updates requires separate explicit owner approval.
   - Exits non-zero on failure and never prints success unless verified.

```python
import getpass
import json
import sys
import urllib.error
import urllib.request

token = getpass.getpass("Enter Bot Token: ").strip()
if not token:
    print("Error: Bot token cannot be empty.", file=sys.stderr)
    sys.exit(1)

# Default: preserve pending updates. Dropping requires separate explicit owner approval.
payload = json.dumps({"drop_pending_updates": False}).encode("utf-8")

req = urllib.request.Request(
    f"https://api.telegram.org/bot{token}/deleteWebhook",
    data=payload,
    headers={
        "Content-Type": "application/json",
        "User-Agent": "Rabet-Operator/1.0"
    }
)

try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = resp.read().decode("utf-8")
except urllib.error.HTTPError as e:
    print(f"Emergency pause failed: Telegram API returned HTTP status {e.code}.", file=sys.stderr)
    sys.exit(1)
except urllib.error.URLError:
    print("Ambiguous result: Network transport error or timeout during deleteWebhook.", file=sys.stderr)
    print("DO NOT assume webhook was paused. Run getWebhookInfo inspection to verify state.", file=sys.stderr)
    sys.exit(1)
except Exception:
    print("Ambiguous result: Unexpected system or I/O error during request execution.", file=sys.stderr)
    print("Run getWebhookInfo inspection to verify current server state.", file=sys.stderr)
    sys.exit(1)

try:
    data = json.loads(body)
except Exception:
    print("Emergency pause failed: Telegram API returned malformed non-JSON response.", file=sys.stderr)
    sys.exit(1)

if not isinstance(data, dict) or data.get("ok") is not True or data.get("result") is not True:
    print("Emergency pause failed: deleteWebhook was rejected or returned non-true result.", file=sys.stderr)
    sys.exit(1)

print("Webhook paused successfully: Telegram Bot API confirmed ok: true, result: true.")
```

#### Restoring Previous Webhook Configuration
- Emergency pause (`deleteWebhook`) is strictly separate from restoring the previous webhook.
- Before altering configuration, the prior URL and options (`allowed_updates`) must be recorded privately in secure operator notes.
- **Important:** `getWebhookInfo` does NOT return the previous secret token. Secure access to the prior secret token from the operator password vault is strictly required before restoration can be promised.
- Restoration Procedure: Re-run `setWebhook` using the verified prior URL, prior secret token, and prior options with `drop_pending_updates: False`. Verify via `getWebhookInfo`.

#### Scenario B: Application Rollback
1. If application defect occurs: In Vercel Dashboard -> Deployments, execute **Instant Rollback** to the prior deployment.
2. *Important Vercel Instant Rollback Note:* According to official documentation ([Vercel Instant Rollback](https://vercel.com/docs/instant-rollback)), executing an Instant Rollback disables automatic production domain assignment from Git pushes until explicitly unpinned. To restore normal Git CI/CD, the operator must re-promote the latest Git deployment in the dashboard once fixed.
3. *Database Independence & Schema Compatibility:* Current migrations (`0000`, `0001`) are additive. Application rollback does NOT roll back PostgreSQL database schema. Do not assume arbitrary prior deployments remain compatible with the current database schema; verify backwards compatibility before rolling back application code.

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
Phase 10B (Next Step - Production Preparation)
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
