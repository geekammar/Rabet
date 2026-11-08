# Phase 10B: Production Database Runner & Operator Setup Packet

> **Status:** Tooling implemented and verified; hosted production execution pending owner review.  
> **Target Scope:** Manual Production database runner, target protection boundaries, and operator instructions for Neon, GitHub, Vercel, and WAF.  
> **Prerequisites:** PR #20 merged (`5b009085aa4e96e9607aa9a801be0034aadc4c40`), owner credentials (`ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `AUTH_SECRET`) verified.

---

## 1. Executive Summary

Phase 10B delivers the audited, dedicated runner and exact operator runbook required to prepare the Rabet Production environment safely.

In accordance with strict safety requirements:
- **No hosted state has been modified:** No Neon project was created or altered, no hosted database migrations have been executed, no Vercel settings or WAF rules were applied, and no Telegram webhooks or bot tokens were touched.
- **Fail-closed database runner:** Built `scripts/neon-prod-actions.mjs` and `.github/workflows/neon-prod-migrate.yml`, featuring explicit target pinning, DEV endpoint rejection, live server identity verification, ledger read distinction, byte-for-byte hash validation, and redacted outputs.
- **Automated verification:** Comprehensive mock unit tests (`tests/wizard/neon-prod-actions.test.ts`) and real PostgreSQL container integration tests (`tests/db/neon-prod-actions.test.ts`) verify all gates, flows, no-ops, and fail-closed behaviors.

---

## 2. Operator Setup Packet

Follow these steps in exact order when approved to prepare the Production environment.

### A. Dedicated Independent Neon Production Target

> [!IMPORTANT]
> The Production database must be completely isolated from `Rabet_dev`. Never fork, branch from, or copy data from the development project.

1. **Create or identify the dedicated project:**
   - Log into the [Neon Console](https://console.neon.tech).
   - Create a new project named **`Rabet_prod`**.
   - Select the desired AWS region (recommend matching Vercel region, e.g., `us-east-1` or `us-east-2`).
   - Create a clean database without importing any template or snapshot.

2. **Record target identities:**
   - **Project Display Name:** `Rabet_prod` *(Note: The display name is a Neon UI label, not the SQL database identity).*
   - **SQL Database Name:** `neondb` (or chosen SQL name, e.g., `rabet_prod`). Record this exact name.
   - **Primary Branch:** `main` (default).
   - **Direct Endpoint Hostname:** In Neon Dashboard → *Connection Details* → select **Direct connection** tab. Record the unpooled host (e.g., `ep-cool-name-12345.us-east-2.aws.neon.tech`).
   - **Verify unpooled status:** Ensure the hostname does **not** contain `-pooler`.

3. **Check recovery and snapshot options:**
   - Check the Point-in-Time Restore (PITR) retention window under Project Settings.
   - Prior to running any migration, create a manual branch snapshot or record the branch creation timestamp as a baseline recovery point.

---

### B. GitHub Environment & Target Configuration

Configure the GitHub repository settings to authorize execution strictly from reviewed code on `main`.

#### Distinction: Workflow Guards vs. GitHub Environment Protection Rules

Security is enforced at two distinct boundaries:
1. **GitHub Environment Protection (Platform-Level Gate):**
   - Configured in GitHub repository settings under the `Production` Environment.
   - Restricts which branches (`refs/heads/main` only) and reviewers can access environment secrets and variables.
   - Provides administrative authorization control before any runner accesses the `Production` environment.
2. **Workflow Guards (Pre-Flight & Execution Gates):**
   - Implemented in `.github/workflows/neon-prod-migrate.yml` and `scripts/neon-prod-actions.mjs`.
   - A dedicated `guard` job runs *before* the `Production`-environment job starts, with no environment, no checkout, and no secret access. It immediately rejects invalid event triggers (must be manual `workflow_dispatch`), non-main branches (`refs/heads/main` only), invalid modes, and missing/untrimmed confirmation phrases (`MIGRATE_RABET_PROD` literally).
   - The `neon-prod` job has `needs: guard` and `if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'`, ensuring the Production-environment job is never entered for invalid requests.
   - The CLI runner (`scripts/neon-prod-actions.mjs`) independently verifies the GitHub Actions context before opening any database connection and refuses execution outside GitHub Actions.

#### Configuration Steps

1. **Create GitHub Environment:**
   - In GitHub repository settings: **Settings → Environments → New environment**.
   - Name the environment exactly: **`Production`** (case-sensitive).

2. **Configure Environment Protection Rules:**
   - **Deployment branches:** Select **Selected branches** → add **`refs/heads/main`** only.
   - **Required reviewers:** If available on your GitHub plan (Team/Enterprise), specify the repository owner as a required reviewer.

3. **Configure Non-Secret Target Settings (Environment Variables):**
   - Under *Environment variables* in `Production`:
     - **`NEON_PROD_EXPECTED_HOST`**: Set to the exact direct unpooled hostname recorded in Section A (e.g., `ep-cool-name-12345.us-east-2.aws.neon.tech`).
     - **`NEON_PROD_EXPECTED_DB_NAME`**: Set to the exact SQL database name (case-sensitive, e.g., `neondb`).

4. **Configure Secret Variable:**
   - Under *Environment secrets* in `Production`:
     - **`NEON_PROD_DATABASE_URL`**: Set to the direct unpooled connection string copied from Neon's Direct Connection tab, with `?sslmode=require` appended (e.g., `postgresql://<role>:<password>@<direct-endpoint-host>/neondb?sslmode=require`).
   - *Security Rule:* Never paste this connection string or password into PR comments, issue descriptions, chat prompts, or workflow dispatch inputs.

---

### C. Migration Execution & Live Verification (Operator Order)

Follow this exact six-step sequence to inspect, backup, migrate, verify, and activate the Production database:

1. **Step 1 — Read-Only Inspection (`inspect` mode):**
   - Navigate to **Actions → Neon PROD database → Run workflow**.
   - Select `Use workflow from Branch: main`.
   - Mode: **`inspect`** (default).
   - Leave `confirm` empty.
   - Click **Run workflow**.
   - **Verify output:**
     - The `guard` job passes and gates execution to `refs/heads/main`.
     - Confirms connection to target and case-sensitive database identity match.
     - For a clean empty database: confirms `0 application tables` and `2 pending migrations` (`0000_initial_schema`, `0001_tree_and_snapshot_integrity`).
     - If inspect sees a complete migration ledger, it automatically validates all critical live schema objects before reporting success.
     - Confirms no DDL or writes occurred.

2. **Step 2 — Record a Verified Restore Point:**
   - In Neon Console, verify project state and PITR retention window.
   - Create a manual branch snapshot (e.g., `pre-migration-0000`) or record the exact branch creation timestamp as a verified restore point.

3. **Step 3 — Migrate Only with Authorization (`migrate` mode):**
   - In **Actions → Neon PROD database → Run workflow**:
   - Select `Use workflow from Branch: main`.
   - Mode: select **`migrate`**.
   - Confirmation: type **`MIGRATE_RABET_PROD`** exactly (literal match, no leading or trailing whitespace).
   - Click **Run workflow**.
   - The runner runs pre-checks, rejects partial/unmanaged/drift states, verifies that `npm run db:check` exits 0, and runs `npm run db:migrate`.

4. **Step 4 — Verify the Live Schema:**
   - Post-migration, the runner automatically re-inspects the live database:
     - Proves live byte-for-byte SHA-256 match against committed SQL files.
     - Confirms live existence of all 14 application tables.
     - Verifies critical indexes, unique constraints, and recursive foreign keys.
     - Verifies a read-only multi-statement batch probe.

5. **Step 5 — Configure Vercel Production:**
   - In Vercel Project Settings → **Environment Variables**:
     - Add **`DATABASE_URL`**.
     - **Target Environment:** Check **Production** ONLY (uncheck Preview and Development).
     - **Connection Pooler:** Use Neon's pooled connection string (host containing `-pooler`) with `?sslmode=require`.
   - **Preserve Existing Verified Admin Credentials:**
     - Confirm that `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, and `AUTH_SECRET` remain untouched.
   - **Pending Telegram Variables (Phase 10C):**
     - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` remain unpopulated until Phase 10C live cutover.

6. **Step 6 — Verify Production Deployment:**
   - Verify that a standard Git deployment of the approved commit on `main` picked up the database configuration without errors.
   - Verify that the application boots cleanly, connects via the pooled connection, and protected routes enforce administrator authentication.

### E. Vercel WAF & Rate Limiting Preparation

To protect the admin login endpoint from credential-stuffing and brute-force attacks while keeping Telegram webhook traffic unhindered:

1. **Scope and Target Endpoints:**
   - Protect real POST credential submissions:
     - `/login` (login Server Action / form submission)
     - `/api/auth/callback/credentials` (NextAuth credentials callback)
   - **Explicit Exclusion:** `/api/telegram/webhook` must **never** be rate-limited by login rules. Telegram server delivery requires uninhibited HTTP delivery.

2. **Verify Account Capabilities & Plan:**
   - In Vercel Console → Project Settings → **Security / Firewall**.
   - Verify available rule capacity on your current plan (e.g., Hobby includes standard DDoS protection and basic rules; Pro includes advanced custom WAF rules).
   - Ensure the minimal single-rule configuration fits within plan limits without incurring unexpected add-on costs.

3. **Proposed Rule Configuration:**
   - **Rule Name:** `Protect Admin Login Submissions`
   - **Action:** Rate Limit / Challenge
   - **Condition (Exact Path Set + Method):**
     - Request Method: `POST`
     - Path: `matches any of` `["/login", "/api/auth/callback/credentials"]`
   - **Rate Limit Window & Threshold:**
     - 5 requests per 1 minute (fixed window) per client IP.
   - **Owner Recovery:**
     - If an owner mistypes credentials and exceeds the limit, the block window clears automatically after 60 seconds. Alternatively, access is restored immediately from an alternative IP (mobile network).

4. **Activation Policy:**
   - Keep existing Vercel Deployment Protection active during preparation.
   - Do **not** publish rules or remove edge protection until Phase 10C live cutover.

---

## 3. Scope Boundaries & Deferrals

As approved in Phase 10 architecture:
- No health-dashboard UI.
- No `login_attempt` database table.
- No Redis, background queues, or worker processes.
- Single seller/admin and single Telegram bot architecture preserved.
