# Setting up the Rabet development database (`Rabet_dev`)

This is the operator guide for the one-command setup wizard. It assumes nothing
except a Linux VPS (or laptop) with Node.js installed, and it works identically
the very first time and on every replacement VPS afterwards.

> **One command.** `npm run db:setup:dev`
>
> It asks before it writes anything, it never touches production, and it never
> runs `drizzle-kit push`. Re-running it is always safe.

---

## 1. First VPS — the initial setup

You need a Neon project named `Rabet_dev` that already exists (the owner
created it). Then, on the new VPS:

1. **Clone Rabet.**
   ```bash
   git clone https://github.com/geekammar/Rabet.git
   cd Rabet
   ```

2. **Install the npm dependencies.**
   ```bash
   npm ci
   ```
   (The wizard checks this itself and offers to run `npm ci` for you if a
   package is missing. `package-lock.json` is never modified.)

3. **Run the wizard.**
   ```bash
   npm run db:setup:dev
   ```

4. **Provide the `Rabet_dev` connection string privately.**
   In the Neon dashboard: **Rabet_dev → Connection Details → the "Direct
   connection" tab → copy the Connection string.** Paste it when the wizard
   asks. Nothing is echoed: the terminal reads the keystrokes with echo
   switched off, and every line the wizard prints is filtered so a connection
   string can never reach the screen, a log or scrollback — not even by
   accident.

5. **Confirm the target.** The wizard shows the database name, the masked
   endpoint, the role, the PostgreSQL version and whether TLS is in use, then
   asks you to confirm this is the dedicated `Rabet_dev` development database.
   The answer defaults to **no**.

6. **Approve the pending development migrations.** The wizard lists the
   committed migrations and marks each one *applied* or *pending*, then asks
   for approval before writing. The default is **no**. If the database already
   contains application data it additionally asks you to type the database
   name, so a wrong target is caught before any write.

The wizard then runs `npm run db:migrate` with the verified URL, re-inspects
the real database afterwards rather than trusting the command's exit code, and
prints a short report. On success it exits `0`.

Optionally, it can save the connection string to `.env.local` (mode `0600`,
git-ignored, unrelated values preserved) so `npm run db:migrate` and
`npm run db:check` work without re-typing it. This is opt-in and it asks first.

---

## 2. Replacement VPS — reconnecting to the existing database

This is the important half. A disposable VPS is replaced, the database is not.
On the new VPS:

1. **Clone the same GitHub repository.**
   ```bash
   git clone https://github.com/geekammar/Rabet.git
   cd Rabet
   ```

2. **Install the npm dependencies.**
   ```bash
   npm ci
   ```

3. **Run the SAME command.**
   ```bash
   npm run db:setup:dev
   ```

4. **Provide the EXISTING `Rabet_dev` URL** — the same string, from the same
   Neon dashboard tab. Nothing else has it; the wizard keeps no state between
   machines.

5. **The wizard recognizes the existing schema.** It inspects the database
   read-only, compares the recorded migration history against the committed
   files byte for byte, and reports the target as *already configured*.

6. **No migrations run if the database is already up to date.** It prints
   *"Development database is already configured. No migrations are pending, so
   nothing is written. Validating instead."* — and validates instead.

7. **Continue development without data loss.** Nothing is dropped, nothing is
   reset, no branch is restored, and no new database is created. The existing
   rows are exactly where they were.

This is proven, not assumed: `tests/db/wizard-reconnect.test.ts` runs the real
wizard twice, from two independent fresh clones, against the same throwaway
database — the first run migrates an empty database, the second must apply
nothing, create no database, and leave a marked test row in place. It also
proves the read-only preflight mode recognizes an existing database from a
third fresh clone.

> The wizard carries **no machine identity**. It does not depend on an IP
> address, a hostname, a home directory, a local database volume, or any state
> a previous VPS or a previous session left behind. Everything it reads is
> relative to the repository clone it is run from; the only thing it needs from
> you is the connection string. A fresh clone plus the URL is a fully
> configured development machine.

---

## 3. Direct vs pooled connection strings — which one to paste

Neon offers two connection strings per branch.

| Tab in the Neon dashboard | Host looks like | Use it for |
| --- | --- | --- |
| **Direct connection** (unpooled) | `ep-…-<region>.aws.neon.tech` | **The wizard.** `drizzle-kit migrate` runs DDL, which the pooler cannot relay reliably. |
| **Pooled connection** | `ep-…-pooler-<region>.aws.neon.tech` | The running application, which pools many short-lived requests. |

The wizard asks for the **direct / unpooled** string. If you paste a pooled one
it warns — the host contains `-pooler` — and offers to take the direct string
instead. You can force the pooled URL through, but a migration may then fail
inside the pooler; prefer the direct tab.

The wizard also requires TLS on any external host: it adds `sslmode=require`
and tells you, and it refuses a string that disables TLS. A loopback or private
address is left alone.

---

## 4. Read-only health check (`--check`)

```bash
npm run db:setup:dev -- --check
```

Steps 1–5 only: project, dependencies, connection, read-only inspection and
the migration review — **no writes, no approval asked**. It connects, classifies
the database, lists what is applied and what is pending, and exits `0` when
everything is consistent.

It is the safe thing to run when you want to know the state of the database
without changing it — for example after an interrupted setup, or before
deciding whether to migrate. It leaves the target completely untouched.

`--help` prints the usage; an unknown option exits `2`.

---

## 5. How to inspect migration status

The wizard's own report is the primary view: it lists the committed chain with
each entry marked *applied* or *pending*, and the final summary shows how many
migrations are recorded against how many are committed, plus the git revision
the wizard ran from.

To inspect manually, against the development database only:

```bash
# The committed chain and its consistency (a repository check — not a dry run).
npm run db:check

# What the database itself records as applied.
# In the Neon console's SQL editor for the Rabet_dev branch:
select id, hash, created_at from drizzle.__drizzle_migrations order by created_at;
```

The wizard compares each recorded hash with the sha256 of the committed
migration file, in chain order. That comparison — not a row count — is what
"the history matches the repository" means.

> **`drizzle-kit check` is not a preview of the SQL that will run.** It
> compares the committed journal and snapshots and reports success even on an
> empty database, and it reports success on a database that is missing the
> latest migration. The wizard therefore never advertises it as a dry run; the
> pending-migration list in step 5 is the preview.

---

## 6. Handling pending migrations

When the database is behind the repository, the wizard:

1. names every pending migration (e.g. `0001_tree_and_snapshot_integrity —
   pending`);
2. asks for explicit approval — default **no**;
3. requires the database name to be typed when application data is present;
4. applies the committed chain through `npm run db:migrate`;
5. re-inspects the database rather than trusting the exit code, and reports
   exactly what this run applied.

Only the pending ones run; migrations already recorded are never repeated.

If `npm run db:migrate` exits non-zero, the wizard diagnoses from the database
itself (drizzle-kit's terminal renderer clears its failing line, so its own
output is often unhelpful). It distinguishes:

- *still empty* — nothing was recorded and nothing was built; almost always a
  permission problem on the role. Re-run; the wizard applies the chain from the
  beginning and repeats nothing;
- *partially applied* — it stops and tells you to inspect
  `drizzle.__drizzle_migrations` or restore the Neon snapshot before deciding.

It never claims success after an ambiguous or partial result.

---

## 7. Unknown schema drift — the wizard stops

If the database contains tables that are not part of the Rabet schema, if the
recorded history matches no committed file, if the database is *ahead* of the
repository, or if the journal says everything is applied while expected tables
are missing, the wizard **stops without modifying anything** and points at the
Neon snapshot for recovery.

There is **no automatic schema-drift repair**. Repairing drift means deciding
which side is right, and that decision belongs to the operator. Take a Neon
snapshot, inspect the database, and either restore the branch or fix the
repository — then re-run the wizard to inspect the real state.

---

## 8. Safe behavior after an interrupted setup

If the SSH session dies, the connection drops, the VPS is discarded, or you
press Ctrl-C:

- **Nothing is left half-applied silently.** A migration runs inside one
  transaction; a failure rolls the whole apply back. The wizard then
  re-inspects the real state instead of trusting an exit code.
- **An interrupted session is detected.** When the input stream has ended, the
  wizard stops rather than answering its own "try again?" prompt with a default
  — it prints `Input ended (the session was interrupted)` and exits non-zero.
- **Retries are bounded.** Transient failures retry automatically with a
  bounded backoff, then a bounded number of manual retries; the wizard
  terminates rather than looping forever.
- **Re-running is the recovery procedure.** Run `npm run db:setup:dev` again,
  or `--check` first if you want to look before anything is proposed. The
  wizard inspects the actual database state and repeats nothing it can prove is
  already done.

---

## 9. What requires manual approval

| Action | Approval |
| --- | --- |
| Connecting | Read-only, no approval — but the target must be confirmed as `Rabet_dev` before any write |
| Running `npm ci` | Asked, and declined cleanly if you say no |
| **Applying migrations** | **Asked, default no** |
| Applying migrations when data exists | Asked, **plus the database name typed** |
| Saving the URL to `.env.local` | Asked, and it never silently overwrites an existing `DATABASE_URL` |
| Optional Vercel Preview step | Asked, and only ever with the explicit `--vercel-preview` flag |

Never approved, by construction: `drizzle-kit push` (wired into no script),
regenerating migration SQL at runtime, dropping or resetting any table, database
or branch, automatic drift repair, seeding records, and any `git` write.

---

## 10. Credential rotation

When a Neon password is rotated (Neon → Rabet_dev → Connection Details → reset
the password):

1. Copy the **new** direct connection string from the dashboard.
2. Run `npm run db:setup:dev`, paste the new string, confirm the target.
3. If the database is already configured, the wizard validates instead of
   migrating. Approve the offer to save the new URL to `.env.local` when it
   asks — the old value is replaced, unrelated values are preserved, and the
   file mode stays `0600`.
4. If you saved the old string anywhere else (a Vercel environment variable, a
   note), rotate it there too. The wizard does not keep a second copy.

Nothing about the schema changes when a password rotates, so no migration is
proposed.

---

## 11. What the wizard never does

- Never touches production. It is never given a production URL and never
  connects to one; it has no production credential and no Neon API access.
- Never prints a connection string or a password. Every line is filtered, and
  error messages describe the problem, not the value you pasted.
- Never passes a credential on a command line (the migration reads the URL from
  a sanitized child environment, and the optional Vercel step pipes it to
  stdin).
- Never lets a stale or production `DATABASE_URL` in your shell reach the
  migration subprocess: the child environment carries **only** neutral keys plus
  the single URL the wizard just verified. `RABET_TEST_PG_URL`, `AUTH_*` and
  `ADMIN_*` are never forwarded.
- Never runs a `git` write command; `.env.local` stays git-ignored.
- Development and production credentials cannot be interchanged silently: the
  target must be confirmed explicitly, and a database name that looks
  non-development (`prod`, `live`, …) draws an extra warning that a name alone
  is not proof of environment.

---

## 12. Optional: Vercel Preview

The wizard works without Vercel. **Vercel CLI and a Vercel token are not
required** — they are not installed by the wizard and are not asked for unless
you opt in.

If you want the development connection string in the project's Preview
environment, the simplest and safest path is the small manual workflow:

1. In the Vercel dashboard: **Rabet → Settings → Environment Variables →
   Add**.
2. Name `DATABASE_URL`, paste the development connection string, and select the
   **Preview** scope only. Never Production.
3. Redeploy the preview branch.

The optional automated path is behind an explicit flag:

```bash
npm run db:setup:dev -- --vercel-preview
```

It runs only after the database setup is complete, requires the Vercel CLI to
be installed **and** logged in, reads the linked project identity
(`.vercel/project.json` or `.vercel/repo.json`), prints the account, project id
and org id, and asks for explicit consent before writing **Preview scope only**.
If the CLI is missing, not logged in, or the repository is not linked, it
reports the manual step above instead of guessing — and it never writes a
Production variable. The URL is piped to `vercel env add` on stdin so it never
appears on a command line.

> Prefer the manual workflow. It is two steps in a dashboard and cannot go
> wrong silently.

Preview branches are schema-only: real customer data is never copied into them.

---

## 13. Troubleshooting

| Symptom | What it means, what to do |
| --- | --- |
| `The database rejected the credentials` | The password or username is wrong, or the string was copied incompletely. Copy the whole string again from the Direct connection tab. The wizard never prints the value you pasted. |
| `The database could not be reached (network error)` | Usually transient. The wizard retries automatically; if it keeps failing, check the host in the string and the VPS's outbound network. |
| `does not exist` / invalid catalog name | The connection reached Neon but the database name does not exist on that endpoint. Pick the right branch in the dashboard. |
| `This looks like Neon's POOLED endpoint` | You pasted the pooled string. Use the **Direct connection** tab. |
| Wizard says `already configured` but the app errors | The app reads `DATABASE_URL` from its own environment, not the wizard's memory. Save the URL to `.env.local`, or export it for the app. |
| `Stopped for manual review` | Ambiguous state — drift, a history that matches nothing committed, or a partial apply. Read the message, take a Neon snapshot, then inspect or restore. Do not blindly re-run. |
| `Input ended (the session was interrupted)` | The SSH session died. Re-run; nothing was written. |

---

## 14. Verification of this guide

Every claim above is backed by an automated test that runs in CI:

| Claim | Test |
| --- | --- |
| First-time setup works end to end | `tests/db/wizard-reconnect.test.ts` (VPS A), `tests/wizard/setup-neon-dev.test.ts` |
| Replacement VPS reconnects and repeats nothing | `tests/db/wizard-reconnect.test.ts` (VPS B) |
| Read-only preflight changes nothing | `tests/db/wizard-reconnect.test.ts` (third clone, `--check`) |
| A pending migration is applied alone, data preserved | `tests/db/wizard-reconnect.test.ts` (prefix fixture) |
| Wrong URL / wrong credentials / network outage / timeout | `tests/wizard/setup-neon-dev.test.ts`, `tests/wizard/wizard-cli.test.ts` |
| Exit status is non-zero on unresolved errors | `tests/wizard/wizard-cli.test.ts` |
| Secrets are redacted, credentials stored safely, `.env.local` preserved | `tests/wizard/setup-neon-dev.test.ts` |
| No destructive SQL, no `drizzle-kit push`, no drift repair | `tests/wizard/setup-neon-dev.test.ts`, `tests/db/wizard-sql.test.ts` |
| No real Neon credential is committed | `tests/wizard/no-committed-credentials.test.ts` |

No real Neon project is contacted by any of these. The integration tests use a
throwaway PostgreSQL cluster (`RABET_TEST_PG_URL`), which is created and deleted
per run.
