# Production platform Super Admin bootstrap

This is the only supported production owner-bootstrap path for the named
platform Super Admin. It is deliberately separate from the Staging seed and
from the database migration runner.

## Two different admin credentials

Do not confuse the named platform Super Admin with the legacy single
administrator:

| Credential | Where it lives | Used by |
| --- | --- | --- |
| Legacy single administrator | `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` in the application runtime environment | The existing env-var admin sign-in configuration |
| Named platform Super Admin | `app_user` row with `platform_role = 'super_admin'` plus its `merchant_credential` hash | The database-backed `/platform/login` owner account |

This runbook provisions only the named platform Super Admin. Its Argon2id hash
is stored in GitHub → Settings → Environments → **Production** as the
environment secret **`RABET_PLATFORM_ADMIN_PASSWORD_HASH`**. It must never be
placed in `ADMIN_PASSWORD_HASH`, a workflow input, or a repository file.

## Files

| File | Purpose |
| --- | --- |
| `.github/workflows/neon-prod-bootstrap-admin.yml` | Manual, Production-only workflow |
| `scripts/neon-prod-bootstrap-admin.mjs` | Transactional one-account bootstrap |
| `scripts/neon-prod-actions.mjs` | Reused production target-identity guards |

## Secret handoff

The Argon2id PHC hash is **never** a workflow input.

1. Generate the password and hash locally with `node scripts/generate-admin-hash.mjs`
   (or the same Argon2id parameters in an offline secret manager). The helper
   prints only the hash; it does not choose where the hash belongs.
2. Store the plaintext password only in the approved private credential store.
3. In GitHub → Settings → Environments → **Production**, add the secret
   **`RABET_PLATFORM_ADMIN_PASSWORD_HASH`** with the PHC hash as its value.
   Do not use the legacy `ADMIN_PASSWORD_HASH` variable for this account.
4. Do not put the password or hash in an issue, PR, workflow input, log,
   artifact, report, repository file or chat.

The workflow reads the hash from `secrets.RABET_PLATFORM_ADMIN_PASSWORD_HASH`.
GitHub masks the value in logs. The script prints only the target host/database
(masked), outcome and user id.

The bootstrap accepts only the documented generator's Argon2id policy:
`argon2id`, version 19, memory cost 19456 KiB, time cost 2, parallelism 1,
16-byte salt and 32-byte digest in canonical unpadded base64. Other PHC values
are rejected before any database connection or write.

## Approved target

The workflow reuses the existing Production environment variables:

- `NEON_PROD_EXPECTED_HOST`
- `NEON_PROD_EXPECTED_DB_NAME`

and the Production environment secret:

- `NEON_PROD_DATABASE_URL`

The script refuses a pooled endpoint, the known development host, loopback/test
hosts, and any host/database that does not exactly match the approved values
before connecting.

## Running the bootstrap

1. GitHub → Actions → **Neon PROD bootstrap platform Super Admin**.
2. Choose **Run workflow** on `main`.
3. Paste the exact full 40-character commit SHA approved for this release into
   the required **`expected_sha`** input. The workflow rejects missing,
   malformed or mismatched values, checks out that workflow event commit, and
   re-verifies `git rev-parse HEAD` before the bootstrap connects to the
   database.
4. Enter the named `admin_email`.
5. Type `PROVISION_RABET_SUPER_ADMIN` exactly in `confirm`.
6. Run. The workflow uses the **Production** environment.

The `Production` environment currently has no required-reviewer protection.
Adding one is recommended before handling the hash, but is an owner decision
and is not changed by this workflow.

## Transaction and retry behavior

The script creates the `app_user` and its `merchant_credential` in one
transaction under an advisory lock.

- New email → creates an active `super_admin` and its credential.
- Existing active `super_admin` with no credential → adds the credential.
- Existing active `super_admin` with the same credential hash → no-op success
  (`already_provisioned`); safe retry.
- Existing non-Super-Admin account → fails without promoting it.
- Existing disabled Super Admin → fails without reactivating it.
- Existing Super Admin with a different credential hash → fails without
  overwriting it.
- Any failure rolls the whole transaction back.

The Staging seed (`scripts/staging-p1-platform-admin-seed.ts`) must never be
pointed at production.

## Verification

- Confirm the workflow run used `main` and the **Production** environment.
- Confirm the run summary reports the approved SHA that matched the workflow
  event commit.
- Confirm the run summary reports a successful outcome.
- Sign in at `/platform/login` with the named account.
- Do not print or upload the password or hash.
