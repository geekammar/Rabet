# Phase 09 Handoff: Seller Inbox, Reliable Replies & Conversation Lifecycle

## 1. Overview & Goal

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

Phase 09 reuses the existing schema (`inquiry`, `inquiry_message`, `customer`), Auth.js admin authentication, and bounded Telegram transport without adding new tables or modifying historical migrations.

---

## 2. Authorization & Security Boundaries

1. **Mandatory Admin Check:**
   Every protected route (`/inquiries`, `/inquiries/[id]`) and Server Action (`sendSellerReplyAction`, `retrySellerReplyAction`, `transitionInquiryStatusAction`) calls `await requireAdmin()` as its very first statement before touching the database or initiating network transport.
2. **Server-Only Recipient Resolution:**
   The browser never supplies customer ID, Telegram chat ID, author identity, or delivery status. The recipient Telegram chat ID is derived strictly on the server from the customer linked to the inquiry in the database.
3. **Safe Diagnostics:**
   Public error messages and persisted failure diagnostics use an allowlisted safe categorization (`network_error`, `timeout`, `rate_limit`, `blocked`, `invalid_payload`, `telegram_api_error`, `unknown`). Raw SQL errors, auth tokens, Telegram API response bodies, and stack traces are never exposed to the client.

---

## 3. Read Paths & UI Architecture

### 3.1 Unified Inbox (`/inquiries`)
- **Filters:** By status (`active` [default], `all`, `open`, `waiting_on_customer`, `resolved`, `closed`) and type (`all`, `product`, `support`).
- **Exact Reference Search:** Case-insensitive, whitespace-trimmed exact reference lookup (`INQ-XXXXXX`).
- **Bounded Pagination:** Deterministic pagination ordered by `updated_at DESC, id DESC`.
- **Zero Business Writes:** Loading or refreshing the inbox performs only read queries.
- **Unavailable State:** Explicit separation between an empty inbox and database connectivity errors (`Inquiries unavailable` alert).

### 3.2 Thread View (`/inquiries/[id]`)
- **Frozen Context:** Renders the customer's frozen `productSnapshot` (name, price, currency, category path) and `selectedOptions` exactly as captured when the customer opened the inquiry. Does not reconstruct context from live catalog records, ensuring threads remain historically accurate even if catalog products are modified or disabled.
- **Support Conversations:** Correctly displays the support category without inferring conversation type purely from nullable `productId`.
- **Message History:** Paginated list displaying customer and seller messages distinctly with authored whitespace preservation (`whitespace-pre-wrap`), auto text direction (`dir="auto"`), message delivery status badges, and delivered timestamps.
- **Loading Semantics:** Viewing or refreshing a thread performs zero writes.

---

## 4. Reply Contract & Durable Operation Identity

### 4.1 Plain-Text Contract
- Outgoing message text is prefixed with `[${reference}]\n\n`.
- Maximum total length including the reference prefix is bounded strictly to **4096 UTF-16 code units** (`MAX_TELEGRAM_MESSAGE_CHARS = 4096`).
- Empty and whitespace-only submissions are rejected server-side.
- The composer UI displays real-time remaining characters and disables submission if over the limit.
- Draft text is preserved in `sessionStorage` (`rabet_draft_inquiry_${inquiryId}`) to prevent loss on navigation or transient failures.

### 4.2 Durable Operation UUID & Reservation
- Each composed reply generates a stable client operation UUID stored in `sessionStorage` and passed with the submission.
- If repeated or retried by the client, the same `operationId` is used.
- In a single Neon HTTP-compatible atomic batch (`executeAtomicBatch` / `toBatchable`):
  1. Acquire pessimistic lock on `customer` by primary key (`SELECT id FROM customer WHERE id = $1 FOR UPDATE`).
  2. Acquire pessimistic lock on `inquiry` (`SELECT id, status, customer_id FROM inquiry WHERE id = $1 FOR UPDATE`).
  3. Assert inquiry is currently active (`open` or `waiting_on_customer`).
  4. Insert exactly one `inquiry_message` with `delivery_status = 'pending'`.
  5. Update inquiry `status = 'waiting_on_customer'`, `last_reply_at = now()`, `updated_at = now()`.
- The database primary key constraint on `inquiry_message.id` prevents duplicate insertions across concurrent requests. If the operation ID already exists with matching body and inquiry, `sendSellerReply` safely returns the existing operation result (`already_reserved`) without sending duplicate Telegram messages.

---

## 5. Transport Delivery & Race Protection

- After the reservation commits, the server sends the message via the bounded Telegram transport.
- **Confirmed Success:**
  Persists `delivery_status = 'sent'`, stores `telegram_message_id`, and sets `delivered_at = now()`.
- **Confirmed Failure:**
  Persists `delivery_status = 'failed'` with allowlisted safe diagnostic.
  - If Telegram returns HTTP 403 bot blocked by user, marks `is_blocked = true` on the customer record. (When the customer subsequently messages the bot, the inbound webhook clears `is_blocked: false`).
- **Race Protection:**
  Transport delivery completion updates only the message row's delivery metadata. It does not overwrite the inquiry's status, preventing race conditions where a customer reply or admin closure occurring during message transmission could be accidentally overwritten back to `waiting_on_customer`.

---

## 6. Explicit Retry & Uncertain Deliveries

- Automatic background retries are avoided to prevent unpredictable duplicates.
- **Explicit Retry Flow:**
  - Initiated explicitly by the seller via the "Retry" button.
  - The failed message row is preserved unmodified (terminal state).
  - A deterministic UUID v5 (`deriveRetryOperationId`) is derived from the source message ID using a fixed namespace.
  - Two concurrent retry clicks resolve to the exact same derived UUID, preventing duplicate sends.
- **Unconfirmed/Stale Deliveries:**
  - If a message remains in `pending` status due to a process crash, it is displayed as "Pending (Unconfirmed)".
  - An explicit retry button is enabled only after a conservative stale interval of 2 minutes (`STALE_PENDING_THRESHOLD_MS = 120_000`), with an explicit warning that the previous message may have reached the customer.

---

## 7. Conversation Lifecycle & Concurrency

### 7.1 Lifecycle Transitions
The seller may transition inquiries through the following validated states:
- `open` → `resolved`
- `waiting_on_customer` → `resolved`
- `open` → `closed`
- `waiting_on_customer` → `closed`
- `resolved` → `closed`
- `closed` → `open` (explicit seller reopen)

Customer replies automatically transition `waiting_on_customer` → `open` via the inbound journey.

### 7.2 Reopen Conflict Prevention
When reopening a closed inquiry:
- Serialized under the `customer` row lock.
- **Product Inquiries:** Asserts no active inquiry exists for the same `(customerId, productId)`. If an active inquiry exists, aborts with a descriptive conflict error including the active inquiry's reference.
- **Support Inquiries:** Asserts no active support inquiry exists for the same `(customerId, category)`.
- If conflict assertions pass, updates status to `open`, clears `closed_at`, and updates `updated_at`.

---

## 8. Verification & Test Evidence

### 8.1 Automated Test Suites
- **Unit Actions Test Suite (`tests/app/actions/__tests__/inquiries.test.ts`):**
  - 9 tests passing (admin authorization, UUID validation, blank body rejection, 4096-char limits, duplicate operation deduplication, delivery failure handling, lifecycle transitions).
- **Database Integration Test Suite (`tests/db/seller-inbox.test.ts`):**
  - 12 comprehensive integration and concurrency tests executed against real disposable PostgreSQL:
    - Test A: Unified inbox listing and deterministic ordering.
    - Test B: Thread details and frozen product context rendering.
    - Test C: Successful plain-text seller reply delivery and inquiry status update.
    - Test D: Durable operation identity deduplication under concurrency.
    - Test E: Rejecting reply to closed inquiry.
    - Test F: Explicit retry deriving deterministic operation ID under concurrent triggers.
    - Test G: Blocked customer detection and 403 handling.
    - Test H: Valid lifecycle transitions (`open` → `resolved` → `closed` → `open`).
    - Test I: Reopen conflict detection for product inquiries.
    - Test J: Reopen conflict detection for support inquiries.
    - Test K: Message delivery race protection (status not reverted on delayed send).
    - Test L: Zero business writes on inbox reads and thread details queries.
- **Telegram Transport Tests (`npm run test:telegram`):**
  - 90 tests passing (including blocked user classification).
- **Full Database Test Suite (`npm run test:db`):**
  - 287 tests passing across all 18 test files.
- **Core Non-DB Test Suite (`npm test`):**
  - 512 tests passing | 281 skipped (DB-requiring tests skipped without `DATABASE_URL`).
- **Typecheck & Linting:**
  - `npm run lint`: 0 errors, 0 warnings.
  - `npm run typecheck`: 0 errors.
  - `npm run db:check`: Drizzle schema check passed.
  - `env -u DATABASE_URL npm run build`: Production Next.js Turbopack build succeeded cleanly.

### 8.2 Real Browser Acceptance Suite (`npm run test:browser:inbox`)
Automated Chrome DevTools Protocol (CDP) acceptance test against a live Next.js production build (`scripts/test-seller-inbox-browser-acceptance.mjs`):
1. **Scenario 1:** Unauthenticated navigation to `/inquiries` cleanly redirects to `/login`.
2. **Scenario 2:** Authenticated admin session successfully accesses `/inquiries`.
3. **Scenario 3:** Inbox renders seeded product and support inquiries with customer name; exact reference search (`INQ-PROD-01`) isolates target inquiry.
4. **Scenario 4:** Thread view opens `/inquiries/[id]`, displaying frozen product snapshot, price, and customer message history.
5. **Scenario 5:** Seller composes multilingual reply containing Arabic text, sends it via Telegram mock, verifies delivery tag `Sent via Telegram`, and verifies persistence and `waiting_on_customer` status after page reload.
6. **Scenario 6:** Unfinished draft text persists in `sessionStorage` across navigation away to inbox and back.
7. **Scenario 7:** Simulated Telegram failure renders honest error state; explicit retry button dispatches retry successfully.
8. **Scenario 8:** Lifecycle operations: transitions from `waiting_on_customer` to `Resolved`, to `Closed` (verifying composer is disabled), and successfully reopens to `Open`.
9. **Scenario 9:** Mobile viewport (360x740) verification: confirmed `scrollWidth = 360` and `clientWidth = 360` with zero horizontal overflow.
