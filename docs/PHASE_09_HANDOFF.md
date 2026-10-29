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
- **`confirmed_failed`:** The transport confirmed delivery rejection (e.g., HTTP 400 or HTTP 403 bot blocked), and the message was persisted as `failed` with safe diagnostics.
- **`recorded_pending`:** The operation exists in the database with status `pending`. Duplicate submissions return `alreadyReserved: true` with `outcome: "recorded_pending"` and `success: false`. The server never equates "operation exists" with "message was sent", and clients do not clear drafts based on a generic success boolean.
- **`unconfirmed_outcome`:** Transport outcome or persistence could not be verified (e.g., transport accepted but returned invalid message ID, or DB persistence threw an exception post-transport). The system does not write `failed` over an ambiguous send, does not auto-resend, and alerts the seller with duplication guidance.

---

## 4. Transport vs. Persistence Separation

`completeSellerReplyDelivery` strictly isolates external transport from internal database persistence:
1. **Separate Transport Execution:**
   Transport send (`transport.sendMessage`) runs in its own try/catch block.
2. **Message ID Validation:**
   Telegram acceptance is only confirmed if `sendRes.messageId` is a valid positive integer.
3. **Atomic State Transition with RETURNING Inspection:**
   Database updates constrain `WHERE id = $1 AND delivery_status = 'pending' RETURNING *`.
   - Zero rows affected triggers an immediate inspection of the authoritative row state.
   - An existing `sent` record is never downgraded by a late or failing update path.
4. **No False Rejection Claims:**
   If Telegram succeeds but saving `sent` throws, the exception returns `unconfirmed_outcome` rather than recording `failed`.
5. **Inquiry Lifecycle Isolation:**
   Delivery completion updates only message delivery fields (`delivery_status`, `telegram_message_id`, `delivered_at`, `delivery_error`). It never alters inquiry lifecycle status (`status`, `closed_at`).

---

## 5. Composer Draft & Operation Lifecycle

The reply composer (`ReplyComposer`) distinguishes between an editable draft and an immutable submitted operation:
1. **Draft Preservation:**
   Authored text persists in `sessionStorage` (`rabet_draft_inquiry_${inquiryId}`) across page reloads and tab navigation.
2. **Bound Operation Association:**
   When submitted, the text and generated operation UUID bind into a `BoundOperation` (`id`, `body`, `status`).
3. **Edit-Detached Fresh Operation:**
   Editing the textarea when bound to a persisted operation automatically detaches `boundOp` and clears the bound key from storage. When the seller submits the edited text, a brand-new operation UUID is generated, eliminating `CONFLICT` errors.
4. **Prevention of Auto-Resend for Failed Operations:**
   If an operation previously failed, the composer does not resubmit it; it directs the seller to explicit retry in the message list.
5. **Reconciliation on Message Retry:**
   When an explicit retry succeeds from the conversation history, `message-list` emits a `rabet:reply_retried` window event, and the composer clears matching bound operations.
6. **Visible Uncertainty Warnings:**
   Unconfirmed outcomes render an inline alert banner detailing duplication risks rather than hiding warnings in hover tooltips.

---

## 6. Lifecycle Concurrency & Zero-Row Protections

Inquiry status transitions in `transitionInquiryStatus` follow rigorous transactional guarantees:
1. **Lock Hierarchy:**
   Always locks `customer` by primary key before locking `inquiry` (`SELECT FOR UPDATE`), maintaining compatibility with inbound message routing.
2. **Authoritative Status Under Locks:**
   Reads source status under lock; transitions from invalid current states (e.g., `closed` → `resolved`) abort with descriptive data errors.
3. **UPDATE RETURNING Inspection:**
   Lifecycle updates inspect affected rows via `RETURNING`. If zero rows are returned due to a concurrent write, the losing request returns a safe `CONFLICT` error rather than claiming success.
4. **Idempotent Already-at-Target Handling:**
   Transitions where the inquiry is already at the target status return `{ success: true, alreadyAtTarget: true }` without updating timestamps or mutating `closedAt`.
5. **Reopen Active-Thread Uniqueness:**
   Reopening an inquiry checks for concurrent active product or support threads for the customer, aborting on duplicate active threads.

---

## 7. Verification Evidence & Test Execution

### 7.1 Automated Suites

| Suite | Command | Result | Notes |
|---|---|---|---|
| Non-DB Unit Tests | `npm test` | **518 passed**, 288 skipped (50 files) | Disposable non-DB suite |
| Telegram Transport | `npm run test:telegram` | **90 passed** (3 files) | Disposable PostgreSQL & transport |
| Database Integration | `npm run test:db` | **294 passed** (18 files) | Disposable PostgreSQL test clusters |
| Drizzle Schema Check | `npm run db:check` | **Passed** | Schema check clean |
| ESLint | `npm run lint` | **0 errors, 0 warnings** | Full codebase linted |
| TypeScript | `npm run typecheck` | **0 errors** | Strict typecheck clean |
| Production Build | `env -u DATABASE_URL npm run build` | **Compiled successfully** | Turbopack production build |

### 7.2 Database Test Matrix for Phase 09 (`tests/db/seller-inbox.test.ts`)
- **Test A:** Unified inbox listing and deterministic ordering.
- **Test B:** Thread details and frozen product context rendering.
- **Test C:** Plain-text reply delivery and inquiry status advancement.
- **Test D:** Durable operation identity deduplication under concurrency.
- **Test E:** Inactive conversation rejection.
- **Test F:** Deterministic retry operation derivation under concurrent triggers.
- **Test G:** Blocked customer detection and 403 handling.
- **Test H:** Valid lifecycle transitions (`open` → `resolved` → `closed` → `open`).
- **Test I:** Reopen conflict detection for product inquiries.
- **Test J:** Reopen conflict detection for support inquiries.
- **Test K:** Message delivery race protection (status not reverted on delayed send).
- **Test L:** Zero business writes on inbox reads and thread queries.
- **Test M:** Fault injection: Telegram accepts but sent persistence throws → leaves pending.
- **Test N:** Fault injection: Zero rows affected on delivery completion.
- **Test O:** Fault injection: Terminal sent state preservation against downgrade.
- **Test P:** Zero additional transport calls on duplicate pending/sent requests.
- **Test Q:** Lifecycle race: Independent connections resolve vs. close race.
- **Test R:** Suppressed lifecycle update timestamp stability.
- **Test S:** Reservation rollback after controlled post-write failure.

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
10. **Scenario 10:** Repaired draft & operation lifecycle:
    - **10A:** Submit failing draft → edit text → submit new reply without `CONFLICT` (detached bound operation generates fresh UUID and succeeds).
    - **10B:** Submit unconfirmed outcome → composer displays visible unconfirmed warning, preserves draft text, and resubmitting unchanged draft produces zero duplicate transport calls.
