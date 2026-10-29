# Phase 09 Handoff: Seller Inbox, Reliable Replies & Conversation Lifecycle

**Status:** In Review (PR #19 on branch `feat/phase-09-seller-inbox`)

---

## 1. Overview & Architecture

Phase 09 completes the seller side of Rabet's customer-to-seller conversation journey:
```
Customer opens inquiry/support on Telegram (Phase 07)
       ↓
Customer messages routed and stored (inquiry / inquiry_message)
       ↓
Seller views unified Inbox (`/inquiries`) & Thread (`/inquiries/[id]`)
       ↓
Seller composes plain-text reply (prefixed with `[INQ-XXXXXX]\n\n`)
       ↓
Atomic DB reservation (Neon HTTP batch with Customer → Inquiry lock hierarchy)
       ↓
Reply delivered to customer via Telegram Bot API
       ↓
Customer replies into the same thread via Telegram
```

Phase 09 strictly reuses the existing schema (`inquiry`, `inquiry_message`, `customer`), Auth.js admin authentication, and bounded Telegram transport without adding new database tables, modifying historical migrations, or altering Phase 07 customer-side behaviors.

---

## 2. Authorization & Boundary Hardening

1. **Mandatory Admin Check:**
   Every protected route (`/inquiries`, `/inquiries/[id]`) and Server Action (`sendSellerReplyAction`, `retrySellerReplyAction`, `transitionInquiryStatusAction`) invokes `await requireAdmin()` before DB query execution or network transport calls.
2. **Server-Only Recipient Resolution:**
   The browser never supplies customer ID, Telegram chat ID, author identity, or delivery status. The recipient Telegram chat ID is derived strictly on the server from the customer linked to the inquiry in the database.
3. **Untrusted Runtime Parameter Validation:**
   - Server action inputs reject `null`, primitives, or non-object payloads.
   - String inputs validate string type before any `.trim()` call.
   - Public new reply submissions require a valid client operation UUID (`clientOperationId`).
   - Query filter parameters enforce allowlists (`VALID_SELLER_FILTER_STATUSES`, `VALID_SELLER_FILTER_TYPES`) rather than silently treating malformed values as `"all"`.
   - Pagination parameters enforce bounded safe integers (`1 <= page <= 10_000`, `1 <= pageSize <= 100`).
4. **Thread Page Error Sanitization:**
   `/inquiries/[id]` validates UUID syntax before querying. Database connectivity errors are explicitly distinguished from non-existent inquiries (`NOT_FOUND` triggers `notFound()`, while DB errors render a sanitized `EmptyState` without masking backend issues as missing resources).

---

## 3. Authoritative Delivery Contract & Outcome Semantics

To prevent false claims of delivery success and improper draft erasure, delivery operations return an explicit four-state outcome union (`SellerDeliveryOutcome`):

```typescript
export type SellerDeliveryOutcome =
  | "confirmed_sent"
  | "confirmed_failed"
  | "recorded_pending"
  | "unconfirmed_outcome";
```

### Outcome Rules:
- **`confirmed_sent`:** The transport explicitly accepted delivery (returning a positive integer `message_id`), and the database successfully transitioned the message from `pending` to `sent`. Only this state uses "Sent successfully" language and clears composer drafts.
- **`confirmed_failed`:** The transport confirmed delivery rejection (e.g., HTTP 400 Bad Request, HTTP 403 bot blocked, or HTTP 429 rate limit), and the message was persisted as `failed` with safe diagnostics.
- **`recorded_pending`:** The operation exists in the database with status `pending`. Duplicate submissions return `alreadyReserved: true` with `outcome: "recorded_pending"` and `success: false`. The server never equates "operation exists" with "message was sent", and clients do not clear drafts based on a generic success boolean.
- **`unconfirmed_outcome`:** Transport outcome or persistence could not be verified (e.g., transport timeout, connection reset, 5xx server/gateway errors, malformed response, or DB persistence threw an exception post-transport). The system leaves the durable status as `pending` with `delivery_error: safeDiag`, never downgrades `sent`, does not mark uncertainty as `failed`, does not auto-resend, preserves the conservative 2-minute stale-pending guard against immediate retry, and alerts the seller with duplication guidance.

---

## 4. Transport vs. Persistence Separation & Uncertainty Semantics

`completeSellerReplyDelivery` strictly isolates external transport from internal database persistence:
1. **Separate Transport Execution:**
   Transport send (`transport.sendMessage`) runs in its own try/catch block.
2. **Explicit Rejection vs. Transport Uncertainty:**
   - **Explicit Telegram Rejection:** HTTP 403 (blocked/deactivated), HTTP 4xx client errors (400 Bad Request, 429 rate limit) transition the message to `delivery_status = 'failed'` with `outcome: "confirmed_failed"`.
   - **Transport Uncertainty:** Timeouts (`errorKind === "timeout"`), network exceptions (`transportException !== null`, `errorKind === "network_error"`), HTTP 5xx gateway/server errors, and missing/invalid positive integer message IDs return `outcome: "unconfirmed_outcome"`. Durable database status remains `pending` with `delivery_error: safeDiag`. Reloading never classifies an uncertain delivery as definitely rejected, preserving conservative stale-pending guard intervals.
3. **Atomic State Transition with RETURNING Inspection:**
   Database updates constrain `WHERE id = $1 AND delivery_status = 'pending' RETURNING *`.
   - Zero rows affected triggers an immediate inspection of the authoritative row state.
   - An existing `sent` record is never downgraded by a late or failing update path.
4. **No False Rejection Claims:**
   If Telegram succeeds but saving `sent` throws, the exception returns `unconfirmed_outcome` rather than recording `failed`.
5. **Inquiry Lifecycle Isolation:**
   Delivery completion updates only message delivery fields (`delivery_status`, `telegram_message_id`, `delivered_at`, `delivery_error`). It never alters inquiry lifecycle status (`status`, `closed_at`).

---

## 5. Composer Draft & Exact Operation Reconciliation

The reply composer (`ReplyComposer`) distinguishes between an editable draft and an immutable submitted operation with exact matching guarantees:
1. **Draft Preservation:**
   Authored text persists in `sessionStorage` (`rabet_draft_inquiry_${inquiryId}`) across page reloads and tab navigation.
2. **Pre-Reservation Failure Recovery:**
   Validation or configuration errors before database reservation (e.g., missing bot token) return `reserved: false`. The composer clears bound operation bindings, leaving the draft freely editable and resubmittable without falsely binding it to a saved failed operation.
3. **Bound & Unresolved Operation Tracking:**
   Submitted operations bind stable UUIDs (`boundOpKey` and `unresolvedOpKey`). When an earlier send is uncertain (`unconfirmed_outcome`), the composer retains the unresolved operation identity separately.
4. **Editing After Uncertainty & Duplication Risk Decision:**
   Editing the textarea when bound to an unresolved uncertain operation does not silently discard the operation or remove warnings. Before submitting edited content after an uncertain earlier send, the seller must explicitly acknowledge the duplication risk via a dedicated confirmation checkbox (`confirm-duplication-risk`). Once acknowledged, a fresh operation UUID is generated. Unchanged draft resubmissions reuse the same operation ID without rotating IDs.
5. **Exact Match Reconciliation on Retry:**
   When an explicit retry succeeds from conversation history (`rabet:reply_retried`):
   - The composer reconciles only if `sourceMessageId === boundOp.id`. Unrelated retries on the same inquiry leave other pending operations and their storage intact.
   - Draft text is reconciled only on exact string equality (`currentBody === retriedBody`). Trim-equality erasure is rejected, fully protecting newer whitespace edits or draft additions.
6. **Visible Mobile-Friendly Uncertainty Warnings:**
   Unconfirmed outcomes render an inline alert banner detailing duplication risks rather than hiding warnings in hover tooltips.

---

## 6. Atomic Lifecycle Transaction Result Semantics

Inquiry status transitions in `transitionInquiryStatus` follow rigorous transactional guarantees:
1. **Lock Hierarchy:**
   Always locks `customer` by primary key before locking `inquiry` (`SELECT * FROM inquiry WHERE id = $1 FOR UPDATE`), maintaining compatibility with inbound message routing.
2. **Snapshot Produced Inside Transaction:**
   Transitions return the exact snapshot produced inside the atomic batch via `RETURNING *` and the locked row snapshot from Statement 2. Post-commit `db.select()` reread is eliminated, preventing races where subsequent concurrent operations are observed.
3. **Idempotent Already-at-Target Handling:**
   Transitions where the inquiry is already at the target status return `{ ...lockedRow, alreadyAtTarget: true }` without rewriting timestamps or mutating `closedAt`.
4. **Controlled Concurrency & UPDATE Suppression Proof:**
   - Under independent connections with controlled barriers, close-first prevents subsequent resolve from falsely succeeding, while resolve-first permits later close, with each response describing its own atomic result and final state matching actual serialization.
   - Fault-injection testing with a `BEFORE UPDATE ON inquiry ... RETURN NULL` trigger proves that a suppressed lifecycle update produces no false success and causes no unintended database mutations.
5. **Reopen Active-Thread Uniqueness:**
   Reopening an inquiry checks for concurrent active product or support threads for the customer under locks, aborting on duplicate active threads.

---

## 7. Verification Evidence & Test Execution

### 7.1 Historical Local Suites vs. Current CI Evidence

| Category | Suite / Check | Command | Historical Executor Result | Current CI Status | Notes |
|---|---|---|---|---|---|
| Static Analysis | ESLint | `npm run lint` | 0 errors, 0 warnings | Blocked at runner allocation | Full codebase lint clean |
| Type Safety | TypeScript | `npm run typecheck` | 0 errors | Blocked at runner allocation | Strict typecheck clean |
| Non-DB Tests | Unit & Action Tests | `npm test` | Passed (51 files) | Blocked at runner allocation | Includes `tests/reconciliation.test.ts` |
| Transport Tests | Telegram Transport | `npm run test:telegram` | Passed (3 files) | Blocked at runner allocation | Disposable PG & fake transport |
| Database Tests | PostgreSQL Integration | `npm run test:db` | Passed (18 files) | Blocked at runner allocation | Includes Phase 09 matrix Tests A–T |
| Schema Check | Drizzle Kit Check | `npm run db:check` | Passed | Blocked at runner allocation | Zero schema drift against migrations |
| Build Check | Next.js Build | `env -u DATABASE_URL npm run build` | Compiled successfully | Blocked at runner allocation | Zero DATABASE_URL dependency |
| Browser Acceptance | CDP Browser Acceptance | `npm run test:browser:inbox` | 10 Scenarios passed | Script ready for CI runner | Confined mocks & transport ledger |

> [!IMPORTANT]
> **CI Diagnostics & Blocker Evidence (Run 40864862300):**
> Inspection of GitHub Actions API (`/check-runs/123416937335/annotations`) proved conclusively that workflow jobs did not start (`runner_id: 0`, elapsed: 2s) due to account payment/spending limits:
> *"The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings."*
> No test or application code failed in CI. Heavy execution was deliberately withheld from the editing VPS in adherence to project resource constraints. Once the repository owner updates billing / spending limits, the CI workflow will run to completion.

### 7.2 Database Test Matrix for Phase 09 (`tests/db/seller-inbox.test.ts`)
- **Test A:** First reply reserves and sends once, updating `waiting_on_customer` and delivery metadata honestly.
- **Test B:** Duplicate submissions return existing operation outcome without re-sending.
- **Test C:** Reusing operation ID with different body or inquiry is rejected (`CONFLICT`).
- **Test D:** Concurrent submissions on independent connections produce exactly one row and one transport call.
- **Test E:** Transport uncertainty (timeout, network exceptions) leaves message `pending` with safe diagnostics and `unconfirmed_outcome`, while explicit Telegram rejection (429 rate limit, 403 blocked) is recorded as `failed`.
- **Test F:** Explicit retry derives stable UUID, and concurrent retries send once.
- **Test G:** Race: Customer replies while seller send is in flight — leaves inquiry status `open`.
- **Test H:** Concurrency: Close before reservation prevents sending; Close after reservation preserves closed state.
- **Test I:** Lifecycle transitions: resolve, close, reopen, and conflict rejection.
- **Test J:** Support conversation classification and reopen conflict by category.
- **Test K:** Frozen context survives live product catalog changes and deletion.
- **Test L:** Inbox read queries: status filter, type filter, reference lookup, pagination, and zero business writes.
- **Test M:** Fault injection: Telegram accepts, but saving sent throws → operation remains pending unconfirmed, never claims failed.
- **Test N:** Fault injection: Telegram accepts, but completion UPDATE affects zero rows → returns `unconfirmed_outcome`.
- **Test O:** Terminal sent state preservation: Existing sent record is not downgraded by a later error path.
- **Test P:** Deduplication: pending duplicate responses never claim sent, and trigger zero extra transport calls.
- **Test Q:** Controlled serialization under independent connections: Close-first prevents resolve from falsely succeeding; Resolve-first allows later close to succeed.
- **Test R1:** Idempotent duplicate lifecycle transition produces `alreadyAtTarget` without rewriting timestamps.
- **Test R2:** Fault injection: Suppressed lifecycle UPDATE via `BEFORE UPDATE` trigger produces no false success and no unintended database mutations.
- **Test S:** Reservation rollback after a controlled post-write failure.
- **Test T:** Exact reconciliation: Unrelated retry does not affect pending operations; unchanged uncertain retry creates zero extra transport calls.

### 7.3 Real Browser Acceptance Suite (`npm run test:browser:inbox`)

Executed against local Next.js production build (`next start`), headless Chromium via Chrome DevTools Protocol (CDP), and disposable PostgreSQL:

1. **Scenario 1:** Unauthenticated navigation to `/inquiries` redirects to `/login`.
2. **Scenario 2:** Authenticated admin session successfully accesses `/inquiries`.
3. **Scenario 3:** Unified inbox renders seeded product and support inquiries with customer name; exact reference search (`INQ-PROD-01`) isolates target.
4. **Scenario 4:** Thread view opens `/inquiries/[id]`, displaying frozen product snapshot, price, and customer message history.
5. **Scenario 5:** Seller composes multilingual reply containing Arabic text, delivers via Telegram, verifies `Sent via Telegram`, and confirms persistence across reload.
6. **Scenario 6:** Unfinished draft text persists in `sessionStorage` across navigation.
7. **Scenario 7:** Simulated delivery failure and explicit retry:
   - Initial send fails with HTTP 400; verified Retry button is present.
   - Database verifies 1 original failed row with `delivery_status = 'failed'`.
   - Explicit retry succeeds; verified 1 deterministic retry row (`expectedRetryId`) with `delivery_status = 'sent'` and `telegram_message_id = 8803`.
   - Filesystem transport ledger verifies exactly 1 failed and 1 successful send occurred.
   - Reload persists the delivered retry message.
   - Clicking Retry again on original source does not create duplicate transport calls (ledger count unchanged).
8. **Scenario 8:** Lifecycle operations:
   - Transition to `Resolved` verified via `data-testid="inquiry-status-badge"` (`data-status="resolved"`) and DB.
   - Transition to `Closed` verified via `data-status="closed"`, DB `closed_at`, and disabled composer banner.
   - Reopen verified via `data-status="open"` and cleared `closed_at`.
9. **Scenario 9:** Mobile viewport (360x740) uncertainty warning:
   - Stale pending message (>2m) renders visible inline uncertainty banner (`Delivery unconfirmed (pending >2m)`).
   - Layout check: `scrollWidth = 360`, `clientWidth = 360` with zero horizontal overflow.
10. **Scenario 10:** Repaired draft & exact operation reconciliation:
    - **10A:** Submit failing draft → edit text → submit new reply without `CONFLICT` (detached bound operation generates fresh UUID and succeeds).
    - **10B:** Submit unconfirmed outcome → composer displays visible unconfirmed warning, preserves draft text, and resubmitting unchanged draft produces zero duplicate transport calls.
    - **10C:** Editing after unconfirmed delivery retains warning and requires explicit duplication-risk acknowledgement (`confirm-duplication-risk` checkbox) before sending new reply.

---

## 8. Remaining Limitations & Reviewer Handoff

Phase 09 remains **IN REVIEW** on PR #19 (`feat/phase-09-seller-inbox`). It must not be marked merged or deployed to production until independent review is complete and the GitHub Actions suite passes with clean evidence.

### Explicit Non-Scope / Phase 10 Boundaries:
1. **Payments, Orders & Checkout:** Out of scope for Phase 09.
2. **Attachments & Media:** Phase 09 supports plain-text replies up to 4096 code units.
3. **Multi-Seller & Tenancy:** Single-seller model preserved.
4. **Realtime Queues & Webhooks:** Long polling and serverless-compatible direct actions only; no background workers or persistent websockets.
5. **Phase 10 Scope:** Live deployment, production smoke acceptance, customer webhook cutover, and mobile operational sign-off.
