# Production platform Super Admin bootstrap

This is the only supported production owner-bootstrap path for the named
platform Super Admin. It is deliberately separate from the Staging seed and
from the database migration runner.

## Files

| File | Purpose |
| --- | --- |
| `.github/workflows/neon-prod-bootstrap-admin.yml` | Manual, Production-only workflow |
| `scripts/neon-prod-bootstrap-admin.mjs` | Transactional one-account bootstrap |
| `scripts/neon-prod-actions.mjs` | Reused production target-identity guards |

## Secret handoff

The Argon2id PHC hash is **never** a workflow input.

1. Generate the password and hash locally with `node scripts/generate-admin-hash.mjs`
   (or the same Argon2id parameters in an offline secret manager).
2. Store the plaintext password only in the approved private credential store.
3. In GitHub → Settings → Environments → **Production**, add the secret
   **`RABET_PLATFORM_ADMIN_PASSWORD_HASH`** with the PHC hash as its value.
4. Do not put the password or hash in an issue, PR, workflow input, log,
   artifact, report, repository file or chat.

The workflow reads the hash from `secrets.RABET_PLATFORM_ADMIN_PASSWORD_HASH`.
GitHub masks the value in logs. The script prints only the target host/database
(masked), outcome and user id.

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
3. Enter the named `admin_email`.
4. Type `PROVISION_RABET_SUPER_ADMIN` exactly in `confirm`.
5. Run. The workflow uses the **Production** environment.

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
- Confirm the run summary reports a successful outcome.
- Sign in at `/platform/login` with the named account.
- Do not print or upload the password or hash.
