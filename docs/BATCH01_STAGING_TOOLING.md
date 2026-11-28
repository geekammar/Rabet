# Batch 01 Staging operator instructions

The tooling targets candidate `dc59091f1424403b3e63674e1ff4bafc215be30d` on the permanent Render service `nokmel-cod-staging` (`srv-dc2ao2e8bjmc73f5cjig`). The separately reviewed tooling checkout contains the candidate Git object as an ancestor. The script reads the migration journal and SQL from that object. All three commands run from the tooling branch on an approved operator host with Git, Node.js 22+, Render HTTPS access and direct TLS access to the pinned Neon endpoint on TCP 5432. These are shell commands with no workflow or branch trigger.

From the root of the reviewed checkout, install dependencies with `npm ci --ignore-scripts`. Inject `NOKMEL_STAGING_RENDER_API_KEY` from the operator's secret store without shell tracing. The Render credential needs access to read the fixed service and individual directly configured variables. Deployment also requires write access to its build label and deploy endpoint. The database credential is read via the fixed service's `DATABASE_URL`; the script checks the direct Neon hostname, database, login role, TLS settings, and the connected database and role. Use a single operator for the release window and suspend other Staging release operations for that window.

1. **Inspect.** Read-only Render requests, a health check, and a read-only PostgreSQL transaction. The report includes the Live deploy ID and SHA. A ledger matching the complete candidate history through 0020 reports `0021_pending`. An exact applied ledger reports `0021_applied`. Any ledger, schema or Live baseline disagreement stops the command.

   ```sh
   node scripts/batch01-staging.mjs inspect
   ```

2. **Migrate after explicit approval.** First verify and record an independently restorable recovery point for the pinned Staging database. Expect `0021_pending` from inspection. The migration locks the ledger, rechecks it, applies only the reviewed SQL, then verifies the schema, fee backfill and exact ledger entry in the same transaction. Running the write again after success is refused.

   ```sh
   node scripts/batch01-staging.mjs migrate MIGRATE_BATCH01_0021_STAGING
   ```

3. **Deploy after separate explicit approval.** Expect `0021_applied` from inspection. The script requires the known Live deploy `dep-dc4ue0h7lnhs739tujr0` at `d914f6c10ade37559b77d8652e3add6738a6c3ba` and matching health, or a previously completed candidate. It requires auto-deploy off. It updates only `RABET_BUILD_SHA` on this service and sends the pinned SHA as Render's `commitId`. Success requires Render to report that commit as Live and the fixed Staging `/api/healthz` to report the same full SHA. Deployment from the linked repository uses the commit ID independently of its configured branch.

   ```sh
   node scripts/batch01-staging.mjs deploy DEPLOY_BATCH01_STAGING
   ```

   If a deploy request or response is uncertain, inspect the Render activity before retrying. The build label can already be saved while the candidate is still building or has failed. Record the prior Live deploy ID for any separately approved app rollback. An app rollback leaves 0021 applied.

## Review and fixture checks

```sh
node --test scripts/tests/batch01-staging.test.mjs
node scripts/db-test-postgres.mjs run -- node --test scripts/tests/batch01-staging.test.mjs
```

The first command exercises the confirmation, identity, ledger and fake Render checks. The second additionally builds the exact 0020 baseline in disposable local PostgreSQL, verifies 0021 and the fee backfill, and demonstrates transactional rollback and repeated-write refusal.

Historical reference points are [the guarded staging deployment](https://github.com/geekammar/nokmel/commit/1af36cba01c4083f151a04983d8a1d6d2e492e44) and [the prior migration run](https://github.com/geekammar/nokmel/actions/runs/45709996213).
