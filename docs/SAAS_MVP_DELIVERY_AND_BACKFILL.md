# Rabet SaaS MVP — Legacy Transition, Backfill Readiness and Delivery Sequence

**Status:** design proposal only. This PR executes no SQL, creates no store,
member, invitation, bot or webhook, changes no deployment, and touches no
production data.

**Repository baseline:** `main` at
`bab0649213461d9df7747a75b54c689e7f9377ef`.

**Related documents:**

- [SAAS_MVP_ARCHITECTURE.md](./SAAS_MVP_ARCHITECTURE.md) — target ownership,
  mobile experience, Telegram provisioning and component decisions.
- [S1.2_TENANT_OWNERSHIP.md](./S1.2_TENANT_OWNERSHIP.md) — the original backfill
  plan and rollback boundary.
- [S1.3A_SAAS_DATA_ARCHITECTURE.md](./S1.3A_SAAS_DATA_ARCHITECTURE.md) — the
  transitional write contract and its explicit limits.
- [RENDER_DEPLOYMENT.md](./RENDER_DEPLOYMENT.md) — current deployment, restore
  point and webhook-cutover context.

**Central rule:** a successful backfill is **not** tenant isolation. It proves
that the rows present during one locked transaction are owned by one legacy
store at one point in time. It does not prove store-scoped reads, per-store
Telegram identity, merchant authorization, or safe operation with two stores.

---

## 1. Contract decisions required before any production backfill

The following owner decisions must be approved first. The first three are hard
blockers because the current backfill and runtime cannot express the result.

| # | Decision | Why it must precede the backfill | Evidence / current gap |
| --- | --- | --- | --- |
| C1 | The legacy store's post-cutover owner: an invited merchant, or the platform operator | Membership, invitation and support ownership are undefined today; `app_user` has no credentials and no membership is created by the backfill | `src/db/schema/tenant.ts:26-32`; `legacy-store-backfill.sql:300-316` creates only `store` |
| C2 | The final ownership contract: all eight roots `NOT NULL`, explicit `inquiry.store_id`, derived records constrained, no NULL compatibility after cutover | The existing backfill leaves nullable columns and no composite ownership FKs; NULL tolerance remains in runtime | `store-context.ts:125-131`; `drizzle/0006_tenant_ownership_expansion.sql`; `S1.3A_SAAS_DATA_ARCHITECTURE.md` §11 |
| C3 | One merchant = one store, and one active store membership | The schema is many-to-many by design; the MVP must fail closed on zero or multiple memberships | `src/db/schema/tenant.ts:19-33`, `:143-173`; `S1.3A_SAAS_DATA_ARCHITECTURE.md` §1 |
| C4 | Per-store uniqueness contract for category/product slugs, template keys, customer Telegram ids and update ids | The existing global unique keys make two stores collide and can expose another store's template | `src/db/schema/customer.ts:39`; `src/db/schema/telegram.ts:43`; `src/db/schema/catalog.ts:68`, `:161`; `src/db/schema/content.ts:35`; `templates.ts:242-251` |
| C5 | Per-store configuration contract: one `bot_setting` row per store, one notification setting per store, enabled languages per store | Both settings tables are constrained to `id = 1` | `src/db/schema/settings.ts:41`, `:76-78`; `src/db/schema/seller-notifications.ts:51`, `:78-81` |
| C6 | Telegram connection contract: one ready connection per store, per-connection webhook secret, `(connection_id, update_id)` dedup | The current webhook has one process-wide secret and one global update id | `src/lib/telegram/webhook.ts:335-359`; `src/db/schema/telegram.ts:43` |
| C7 | Cutover policy: maintenance window, quiescence method, abort criteria, restore point and rollback boundary | `ACCESS EXCLUSIVE` locks block reads as well as writes; no production lock duration is known | `legacy-store-backfill.sql:99`, `:137-159` |
| C8 | Whether the legacy backfill remains a one-time operator artifact or becomes a tested runbook step | It is deliberately not wired into any runner, workflow or build | `S1.2_TENANT_OWNERSHIP.md` §5; `docs/backfill/*.sql` |

### 1.1 Two different gates

Do not merge these into one approval:

1. **Pre-backfill gate:** C1, C2, C3, C7 and C8. These decide what the backfill
   means and whether it is operationally safe.
2. **Pre-second-store gate:** C4, C5 and C6 plus the target read/write scoping
   and cross-store tests. These decide whether a merchant store may exist beside
   the legacy store.

The backfill must run **before any second store is created**. The current
backfill refuses an unrelated store, and the current runtime fails every write
path that calls the legacy resolver when more than one store exists. (Seller
inbox and delivery-retry paths do not call it, which is one reason the second
store is unsafe even after the backfill.) Both behaviors are safety properties,
not bugs to route around.

---

## 2. Does the existing backfill still match the contract?

The artifacts are `docs/backfill/legacy-store-backfill.sql` and
`docs/backfill/legacy-store-verification.sql`. They were reviewed against the
current schema, runtime and tests.

### 2.1 What is still correct

| Property | Evidence | Assessment |
| --- | --- | --- |
| One atomic `DO` statement | `legacy-store-backfill.sql:38-603`; `S1.2_TENANT_OWNERSHIP.md` §5.1 | Keep |
| Idempotent legacy store creation and reuse | `legacy-store-backfill.sql:292-316`; test `tests/db/tenant-ownership.test.ts:629` | Keep |
| Migration baseline check | `legacy-store-backfill.sql:101-132`; test `:900` | Keep, but it only checks a count, not the expected journal identity |
| Schema and eight-root column checks | `legacy-store-backfill.sql:114-132` | Keep |
| Exact legacy store identity check | `legacy-store-backfill.sql:311-315`; test `:829` | Keep |
| Refuses a pre-owned row or another store | `legacy-store-backfill.sql:318-336`; tests `:790`, `:862` | Keep |
| Updates only the eight roots | `legacy-store-backfill.sql:350-357` | Keep |
| Derived rows inherit, not copied | `legacy-store-backfill.sql:338-357`; `S1.2_TENANT_OWNERSHIP.md` §2.1 | Keep |
| Preserves `updated_at` by disabling touch triggers | `legacy-store-backfill.sql:343-364` | Keep if trigger names remain exact |
| Postflight no NULL / no wrong store | `legacy-store-backfill.sql:367-383`; verification `:40-71` | Keep |
| Relationship checks | `legacy-store-backfill.sql:399-461`; verification `:73-127` | Keep |
| Activation, delivery and Telegram identity preservation | `legacy-store-backfill.sql:269-289`, `:563-592` | Keep |
| Rollback during the transaction | The single `DO` statement rolls back on any exception; test `tests/db/tenant-ownership.test.ts:736` | Keep |

### 2.2 What no longer matches the target contract

| Gap | Evidence | Consequence |
| --- | --- | --- |
| No `NOT NULL` enforcement | `drizzle/0006_tenant_ownership_expansion.sql` adds nullable columns; the backfill only updates values | New `NULL` rows are still possible until the scoped write path and later constraints ship |
| No composite ownership foreign keys | Only single-column FKs exist; `S1.2_TENANT_OWNERSHIP.md` §2 defers composite FKs | A dependent row can still point across stores if a future write path is wrong |
| No `inquiry.store_id` | `src/db/schema/inquiry.ts` has no store column; ownership is inferred | Inquiries and seller replies need join-based scoping and cannot be indexed by store directly |
| No per-store uniqueness | Global unique keys remain (`customer.telegram_id`, `telegram_update.update_id`, slugs, template key) | The backfill cannot make two stores safe |
| No connection identity | The backfill stamps `telegram_update.store_id`, but there is no `telegram_connection` | A future second bot still has no trustworthy store mapping |
| No membership creation | `legacy-store-backfill.sql:300-316` creates only `store` | After backfill there may be zero `store_membership` rows; the merchant login has no owner |
| Preservation snapshot is not content-complete | Baseline/postflight at `:163-290` and `:466-593` hash counts, links, settings, delivery state, update state and activation; translations and catalog names/prices are only counted; inquiry bodies and snapshots are not hashed | A content mutation that preserves counts and links could pass. This is a real weakness in the "preserved" claim |
| No dry-run artifact | Only the write statement and post-write verification exist | Lock timing, trigger names and postflight behavior cannot be measured on a clone without an ad hoc transaction |
| No statement timeout inside the `DO` body | `lock_timeout` is set at `:99`; no `statement_timeout` is set | Locks can be acquired within 10 s and the update can then run longer than the window |
| `ACCESS EXCLUSIVE` blocks reads | `:137-159` locks 21 tables including `telegram_update`, `inquiry` and `inquiry_message` | The customer bot and dashboard can stall for the transaction duration, not just writers |
| It is not a migration or runner step | `S1.2_TENANT_OWNERSHIP.md` §5 | An operator must run it with `psql` and capture evidence; no automation |

### 2.3 Verdict

The backfill **still matches the S1.2 point-in-time legacy ownership contract**
and should not be rewritten merely for style. It does **not** match the target
SaaS contract and cannot be used as the final ownership migration. The right
sequence is:

1. approve C1–C3 and C7–C8;
2. deploy the compatible, store-scoped runtime and schema additions;
3. backfill the legacy rows before any second store exists;
4. verify, reconcile and monitor;
5. only then enable the second store after C4–C6 and cross-store tests pass;
6. add `NOT NULL`, composite FKs and per-store uniqueness as separate,
   reversible steps with their own backfills.

Do not combine steps 3 and 6 into one production jump.

---

## 3. Dry-run evidence and checks across all eight ownership roots

### 3.1 Read-only preflight (production, before any write)

Run inside the approved inspection session, not from the application, and record
the output. This is read-only.

For each of `bot_setting`, `category`, `customer`, `message_template`,
`payment_method`, `product`, `seller_notification_setting`, `telegram_update`:

- total rows;
- rows with `store_id IS NULL`;
- rows with `store_id` equal to the legacy store id;
- rows with any other `store_id`;
- distinct `store_id` values.

Also record:

- `store` row count and the exact identity of any `legacy-store` row;
- `app_user` and `store_membership` counts;
- the applied migration ledger count and tags (`drizzle.__drizzle_migrations`);
- `getWebhookInfo` `pending_update_count`, `last_error_date`,
  `last_error_message` and the registered URL (read-only Telegram call by the
  operator, not this session);
- the count of `telegram_update` rows with `processed_at IS NULL` and a live
  lease;
- the count of inquiries/messages and the latest `updated_at`;
- `pg_total_relation_size` for the 21 locked tables, to estimate lock duration.

The existing verification SQL is **post-write only**; it is not a dry run. A
separate read-only preflight artifact should be added in the implementation PR,
not in this design PR.

### 3.2 Clone dry run

Use a verified Neon branch/snapshot of production, never production itself.

1. Record the snapshot/branch id and creation time as the recovery point.
2. On the clone, run the same whole-file `psql` execution:
   `psql "$CLONE_URL" -v ON_ERROR_STOP=1 -f docs/backfill/legacy-store-backfill.sql`.
3. Run `legacy-store-verification.sql`; every `assertion` row must be `true`.
4. Independently compare pre/post content, not only counts:
   - category/product slugs, prices, activation and sort order;
   - every translation body;
   - template keys, descriptions and translation bodies;
   - inquiry `product_snapshot`, `selected_options`, status, reference;
   - every `inquiry_message` body, author and Telegram message id;
   - customer Telegram identity and language fields;
   - seller notification settings and delivery state;
   - Telegram update ids, types, receipts and processed state;
   - `updated_at` on the seven trigger-managed tables.
   A row-level `EXCEPT`/`EXCEPT ALL` comparison or a per-table content digest is
   acceptable; a count alone is not.
5. Record wall-clock duration, lock wait, any `lock_timeout` abort and the
   postflight notice.
6. Repeat the negative cases on separate clones: second store present, wrong
   legacy slug identity, a pre-owned row, and a missing schema object. Each must
   abort with no ownership change. These are already covered on disposable
   databases by `tests/db/tenant-ownership.test.ts:736`, `:790`, `:829`, `:862`
   and `:900`, but the production clone is the operational evidence.

### 3.3 Dry-run acceptance

- All eight roots report zero NULL, zero wrong-store and zero other-store rows
  after the rollback-verified dry run.
- The content comparison is empty.
- The negative cases abort.
- The measured lock duration fits the approved window with margin.
- The restore point is verified by restoring a scratch branch and comparing a
  known row.

### 3.4 Current evidence gap

This session has no production or clone access. The existing tests prove the SQL
on disposable PostgreSQL, but they do **not** prove the production lock time,
the production trigger names, the production row counts, the live restore point
or the live Telegram queue. Those remain unverified until the operator runs the
approved dry run.

---

## 4. Production cutover design (not executed)

### 4.1 Preconditions

- C1–C3 and C7–C8 approved in writing.
- The store-scoped runtime is deployed and health-checked, but the second store
  is not created.
- A restore point is recorded and a restore rehearsal has passed.
- The Telegram webhook is paused with `deleteWebhook(drop_pending_updates=false)`
  (or the approved equivalent), and `pending_update_count` is recorded.
- In-flight update leases are drained or allowed to expire; no attempt is
  actively writing.
- The dry run and content comparison passed on the clone.
- The maintenance window and communication are approved.

### 4.2 In-flight Telegram work

The webhook claims an update with a 30-second lease
(`src/lib/data/telegram.ts:13-14`, `:67-160`) and writes a durable receipt before
completing (`:240-273`). Cutover rules:

- Do not start the backfill while an attempt holds a live lease.
- Pause delivery before the lock so new updates do not queue on a blocked table.
- Allow the lease window plus a margin to expire; then count unprocessed rows.
- A committed receipt survives the backfill because the backfill does not touch
  `payload`; a retry after cutover must find the receipt and must not duplicate
  the customer message.
- After cutover, re-register the webhook with the same secret (or the approved
  per-connection secret) and `drop_pending_updates=false`, then watch
  `pending_update_count` drain to zero.
- Any update that arrives after the lock but before re-registration is held by
  Telegram according to the approved runbook; it must be deduplicated by
  `(connection_id, update_id)` in the target.

The current runbook documents pause/resume and the 24-hour Telegram queue at
`docs/RENDER_DEPLOYMENT.md:554-568`. It does not currently cover this backfill;
the implementation PR must extend it or add a separate runbook.

### 4.3 Execution order

1. Record the restore point and snapshot id.
2. Pause webhook delivery; record pending count.
3. Drain/expire in-flight leases; record unprocessed rows.
4. Run the read-only preflight and record all eight roots.
5. Run the whole-file backfill with `ON_ERROR_STOP=1`; do not split it.
6. Run `legacy-store-verification.sql`; review every assertion, not just the exit
   code.
7. Run the independent content comparison and the eight-root NULL/wrong-store
   query.
8. Resume the webhook; monitor `pending_update_count` and duplicates.
9. Run the reconciliation checks in §4.5.
10. Record the final evidence bundle.

### 4.4 Lock-time review

`lock_timeout = 10s` bounds lock **acquisition**, not execution
(`legacy-store-backfill.sql:99`, `:137-159`). The statement takes
`ACCESS EXCLUSIVE` locks on 21 tables, which blocks reads as well as writes.
Before the window:

- estimate table sizes and the update cost for the eight roots;
- set an approved `statement_timeout` outside the file or in the `psql` session;
- confirm no long-running transaction holds a conflicting lock;
- measure the clone run and add margin;
- define the maximum acceptable lock duration and the abort action if exceeded.

If the duration is unacceptable, split the work by table with a reviewed,
resumable plan. Do not silently extend the window or run an unbounded statement.

### 4.5 Post-cutover reconciliation

Run after commit and again after the first webhook drain:

- Eight roots: `NULL` count = 0; wrong-store count = 0; other-store count = 0.
- `store` count = 1 and identity still exact.
- Category parent/child, product/category, inquiry/customer, inquiry/product,
  inquiry-message/thread and delivery/thread mismatches = 0.
- Content comparison: no changed slug, price, translation body, template body,
  inquiry snapshot, message body, delivery state, activation flag or `updated_at`.
- Telegram: duplicate `update_id` = 0 in the legacy scope; unprocessed rows are
  either actively leased or explicitly reconciled; receipts preserved.
- Inquiries/messages: counts and latest timestamps match the baseline.
- Notification deliveries: status counts and references unchanged.

Then monitor for 24 hours:

- any new `NULL` `store_id` in the eight roots;
- any cross-store relation mismatch;
- webhook `last_error_message` and pending count;
- duplicate customer/inquiry effects.

**No new NULL ownership after cutover** is proven only when:

1. the deployment that writes with the trusted scoped context is live;
2. no store is missing or ambiguous;
3. the 24-hour monitor shows zero new NULLs; and
4. the final `NOT NULL` constraint is applied successfully.

A one-time zero count immediately after the backfill is not that proof.

### 4.6 Recovery point, abort and rollback

| Item | Design |
| --- | --- |
| Recovery point | Verified Neon branch/snapshot immediately before the window; record branch id and timestamp |
| RPO | Backfill changes only `store_id`; the RPO is the snapshot creation time. Any write after the snapshot is lost only if the branch is restored |
| RTO | Restore the branch, repoint the connection, verify health and ownership. The restore rehearsal is required; the actual RTO is unverified until measured |
| Abort before commit | Any preflight mismatch, wrong store identity, pre-owned row, second store, lock timeout, statement timeout, postflight assertion failure or content difference. The `DO` statement rolls back atomically |
| Abort during webhook drain | Keep the webhook paused; do not re-run the backfill until the cause is understood |
| After commit | Do not drop columns. The safe application rollback is the previous image, which ignores `store_id`. A data rollback requires the verified restore point |
| Rollback boundary | Before commit: automatic. After commit: application rollback is cheap; data rollback is a restore, not a SQL undo. Dropping ownership columns is destructive and needs a separate approved plan |
| Review | Record the exact SQL file hash, psql version, operator, window, lock duration, assertion output, content-diff output and restore point |

The existing `S1.2_TENANT_OWNERSHIP.md` §6 rollback boundary remains correct:
before backfill, dropping additive columns is safe; after backfill, dropping them
is destructive.

---

## 5. Ordered delivery plan ending in an invite-only pilot

Each phase has a gate. A phase may start only when the previous gate is met.

| Phase | Work | What it proves | What it does not prove | Can run in parallel with | Must wait for |
| --- | --- | --- | --- | --- | --- |
| 0 | Approve C1–C8 and the open owner decisions | The target contract is agreed | Anything about production | Doc review, UI design | Nothing |
| 1 | **S1.3-B1:** merchant credential, invitation, merchant session, operator/merchant principal split, `StoreScope` resolver, membership guard | A merchant can accept an invite and can only resolve their own store | Catalog/inquiry read isolation; Telegram scoping | UI strings and component design; invitation email copy | C1–C3, credential storage decision |
| 2 | **S1.3-B2:** store-scoped reads/writes, per-store settings/languages, per-store business keys, `inquiry.store_id` and composite ownership constraints | Every dashboard and data-layer path is store-scoped | Telegram connection identity; production backfill | Phase 1 UI; test fixtures for two stores | Phase 1 gate; C4, C5, C8 |
| 3 | **S1.3-B3:** Telegram connection model, per-connection webhook, managed-bot provisioning spike first, then implementation | Inbound updates resolve one connection to one store; provisioned bot is bound to the authenticated merchant | That correlation works live until the spike passes; production readiness | Phase 1/2 scoping work; the spike uses test bots only | C6; spike result; Phase 2 gate |
| 4 | Legacy dry run on a verified clone; production backfill; verify and reconcile | The legacy rows are owned by the legacy store at a point in time; no new NULL after the scoped runtime | Tenant isolation; second-store safety | Post-cutover monitoring; pilot content setup on staging | Phases 1–3 deployed; C1–C3, C7, C8; restore point; window |
| 5 | Two-store/two-connection isolated test suite in CI | Cross-store access is denied at the dashboard, data layer, webhook and worker boundaries | Live Telegram behavior; production performance | Phase 6 preparation | Phase 2 and Phase 3 code |
| 6 | Invite-only pilot: first merchant/store, then a second production store only after Phase 5 passes | The real merchant journey works under isolation | Scale, billing, staff, WhatsApp | Monitoring and support | Phase 4 and Phase 5 gates |
| 7 | Final hardening: `NOT NULL`, composite constraints, drop legacy resolver and old unique indexes; later notifications | The transitional code can be retired | Future product scope | Notification milestone | Zero NULL, zero cross-store mismatches, all stores migrated |

### 5.1 What must not run in parallel

- Do not run the production backfill before Phase 1–3 code is deployed and
  verified. The current runtime can write `NULL` ownership, and the current
  resolver cannot serve two stores.
- Do not create a second production store before the backfill and Phase 2/3
  scoping. Today that would make the legacy resolver fail closed and could expose
  global reads.
- Do not drop the legacy unique indexes or singletons before their replacement
  data is backfilled and verified.
- Do not enable a second production bot before the two-connection isolated tests
  and the managed-bot correlation spike pass.
- Do not treat the backfill as the isolation gate.

### 5.2 Pilot shape

1. **Pilot A:** the legacy store, with an invited owner if C1 says the merchant
   owns it, or explicitly operator-managed if not. All catalog, translations,
   inquiries and activation flags must match the pre-cutover baseline.
2. **Pilot B:** one second store created only after Phase 5. It uses a separate
   merchant, separate store, separate bot connection and synthetic/staging data
   first.
3. The second production store is enabled only after the staging two-store matrix
   passes and the operator records the evidence.

---

## 6. Two merchants, two stores and two bot connections in isolation

### 6.1 Fixture shape

Create in an isolated PostgreSQL database (the existing
`tests/db/helpers.ts` pattern):

- `store` A and B, both active, distinct slugs.
- `app_user` A and B, both active, distinct emails.
- `store_membership` A->A and B->B, both active, role owner.
- `telegram_connection` A and B, both ready, distinct public ids, bot user ids and
  webhook secret hashes.
- The same Telegram user id as a customer in A and in B.
- The same `update_id` claimed by connection A and connection B.
- Categories/products with the same slug in A and B.
- Templates with the same key in A and B.
- One inquiry in A and one in B, plus one message and one delivery each.
- One notification setting per store, both disabled.

Do not use a real Telegram token. Use the existing injected transport/test seam
(`tests/db/telegram-journey.test.ts` and `src/lib/telegram/webhook.ts:60-73`).

### 6.2 Test matrix

| Boundary | Test | Expected |
| --- | --- | --- |
| Merchant session | A signs in; B's store id is placed in URL and form | A resolves A only; B id is 404, never a switch |
| Membership | Revoke A's membership mid-session | A is denied on the next request; no cached scope survives |
| Session version | Increment `app_user.session_version` | A's old JWT is rejected |
| Catalog read | A lists products/categories | Only A rows; B's same slug is invisible |
| Catalog write | A updates B's product id | No write; generic not-found |
| Relation | A creates a product under B's category | Constraint/ownership error; no write |
| Template | A creates a key that exists in B | Creates A's own row; does not return B's |
| Customer identity | Same Telegram id messages both bots | Two customer rows, one per store |
| Update dedup | Same update id arrives on A and B | Both process once; no cross-store collision |
| Webhook secret | A's URL with B's secret | 401; no write |
| Connection status | Revoke B's connection, then deliver an update | 401/404; no business write |
| Inquiry read | A opens B's inquiry id | 404; no message content |
| Seller reply | A replies to B's inquiry | No write/send |
| Inquiry relation | A creates an inquiry for B's product | Cross-store error |
| Notification worker | B's delivery retried in A's scope | Not claimed; no send |
| Retry after revoke | A's in-flight update completes after A's connection is revoked | Completion rejected; no send |
| Settings | A changes currency/language | B unchanged |
| Store link | A's bot username resolves A's connection | Exactly one store |

### 6.3 Commands and CI

Add the new suites under `tests/db/` and run them in the existing isolated
PostgreSQL CI job (`.github/workflows/ci.yml` `db` job). The job already applies
the full migration chain and refuses Neon/Vercel credentials. A managed-bot
provisioning suite uses synthetic `managed_bot` events and an injected HTTP
transport; it does not contact Telegram.

The live test-bot spike is separate and operator-run. It is not a CI job and must
never use production credentials.

### 6.4 Exit criteria before a second production store

- Every matrix row passes in CI on the exact SHA to be deployed.
- The full existing suite still passes (no regressions in catalog, inquiry,
  notifications or Telegram journeys).
- The operator records the store/connection ids and the CI run URL.
- The second store is created through the approved invitation flow, not by a
  manual SQL insert.
- Cross-store access is denied in staging with real sessions and two real
  connections before production gets the second store.

---

## 7. First implementation PR after this design review

### 7.1 Selected slice: S1.3-B1 — invitation, merchant identity and resolved store context

**Why this slice first.** The repository defers exactly this work to S1.3-B:
`S1.3A_SAAS_DATA_ARCHITECTURE.md:318-329` lists merchant authentication,
invitations, onboarding and membership enforcement as the next deferred items.
The current `app_user` has no credentials, `store_membership` has no runtime
consumer, and `requireAdmin()` is the only authenticated principal. Every later
scoping change needs a trusted `app_user -> membership -> store` source; without
it, a "store-scoped read" would still have to invent a store from the browser or
the legacy resolver.

This is **not** a divergence from the roadmap; it is the roadmap's first
deferred item. The reason to name it explicitly is that the older Phase 10
roadmap stops at the single-store launch and does not mention S1.3-B.

### 7.2 Expected files and modules

These are proposed paths, not changes in this PR:

- `drizzle/0008_merchant_invitations.sql` — additive invitation/credential schema.
- `src/db/schema/tenant.ts` — credential metadata, invitation table or module.
- `src/lib/auth/merchant-credentials.ts` — Argon2id verification and generic
  failures.
- `src/lib/auth/merchant-session.ts` — `requireMerchant`, principal claim,
  session-version check.
- `src/lib/data/merchant-invitations.ts` — create/accept/revoke invitation,
  single-use token hash, expiry.
- `src/lib/data/merchant-store-context.ts` — resolve exactly one active
  membership and active store; return a branded `StoreScope`.
- `src/auth.ts` — add a merchant credentials provider without changing the
  operator provider.
- `src/proxy.ts` — protect `/app` routes and the invitation landing page.
- `src/app/(auth)/invite/[token]/page.tsx` and
  `src/app/(auth)/app/login/page.tsx` — invitation acceptance and merchant
  sign-in.
- `src/app/actions/merchant-auth.ts` — accept invitation, sign in/out, safe
  redirect validation.
- `tests/db/merchant-invitations.test.ts`,
  `tests/db/merchant-store-context.test.ts`,
  `src/app/actions/__tests__/merchant-auth.test.ts`.

The PR must stay additive and must not create a production store, send a real
invitation, or change the operator credentials.

### 7.3 Dependencies

- Approved C1, C2, C3 and the credential-storage decision.
- Approved session principal model: operator and merchant must not share an
  authorization path accidentally.
- The existing Auth.js version and Argon2id library; no new auth dependency.
- No dependency on the backfill or on Telegram provisioning.

### 7.4 User outcome

An invited merchant can accept a single-use invitation, set a password, sign in,
and land on a store-aware onboarding shell that shows only their store. The
operator login continues to work exactly as today. A merchant cannot see,
select or address another store.

### 7.5 Acceptance tests

- Invitation token is stored hashed, single-use, expires, and is bound to the
  invited email and store.
- Expired, reused, revoked and wrong-email tokens return one generic failure; no
  account or membership is created.
- Accepting creates or reuses exactly one `app_user` and exactly one active
  `store_membership`.
- A merchant session carries a principal type and `app_user` id; it cannot call
  operator-only actions.
- A revoked membership or bumped `session_version` is denied on the next request.
- Two merchants and two stores: A resolves A; B's id in a URL or form is denied;
  no store switching; multiple memberships fail closed.
- CSRF, rate limiting, safe redirects and generic errors are covered.
- The existing auth, unit and DB suites still pass.
- No secret, token hash, password hash or store row from another merchant appears
  in a response or a log.

### 7.6 Stop condition

Stop before writing the migration if any of the following is true:

- C1, C2, C3 or the credential-storage decision is not approved.
- The session principal model cannot keep operator and merchant authorization
  separate without weakening `requireAdmin()`.
- A two-merchant/two-store test cannot prove that A cannot resolve B.
- The design would require a destructive change to `app_user`,
  `store_membership` or the existing operator login.
- Invitation delivery cannot be made safe without a production email provider or
  a manual operator handoff decision.

If the stop condition is reached, do not "temporarily" create a merchant store,
run the backfill, or provision a bot to work around it.

### 7.7 What this PR explicitly does not do

- It does not scope catalog or inquiry reads.
- It does not change the legacy resolver or the eight ownership roots.
- It does not add per-store settings, per-store uniqueness or composite FKs.
- It does not add a Telegram connection or provision a bot.
- It does not run the backfill.
- It does not create a second production store.
- It does not prove tenant isolation.

The next PR after it should be the store-scoped data layer (S1.3-B2), followed by
the Telegram connection layer (S1.3-B3), with the backfill and pilot gates in §5.

---

## 8. Evidence gaps and stop-and-decide items

| Gap | Why it matters | Smallest next evidence |
| --- | --- | --- |
| No production inspection in this session | The applied migration state, store count, `NULL` counts and webhook state are assumptions | Operator runs the read-only preflight and records output |
| No restore rehearsal | RTO and restore integrity are unverified | Restore a scratch branch and compare a known row |
| No clone dry run | Lock duration and production trigger names are unverified | Clone run with content diff and timing |
| No live Managed Bot test | Correlation is UNVERIFIED | Test-bot spike in §8.4 of the architecture document |
| No two-store runtime test | Read/write isolation is unproven | The §6 matrix on an isolated database |
| Content preservation is not hashed in the existing SQL | A silent translation/inquiry content change could pass | Add content digests/exceptions before the production run |
| Current runtime writes `NULL` when no store exists | A deployment timing mistake can create new NULLs after cutover | Deploy the scoped runtime, monitor, then add `NOT NULL` |
| The backfill is not wired to a runner | Operator execution can be inconsistent | Approved runbook and evidence template, not automation |

**Stop and raise a decision** if the team cannot prove any of the following
before enabling a second production store:

1. Merchant identity resolves exactly one store from a verified membership.
2. The incoming Telegram connection resolves exactly one store from a verified
   webhook credential.
3. The legacy restore point and dry run are verified, or the cutover is
   postponed.
4. Cross-store access is denied by the isolated two-store matrix.

Until then, the correct state is one production store and no claim of tenant
isolation.
