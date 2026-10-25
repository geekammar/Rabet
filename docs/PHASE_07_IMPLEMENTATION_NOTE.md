# Phase 07 Implementation Note: Durable Writes, Serialization, and Retries (PR #18)

## 1. Create/Resume Serialization Strategy (Repaired for Neon HTTP & PostgreSQL)

### The Single-Statement Snapshot Problem and Solution
- In PostgreSQL default `READ COMMITTED` isolation, every statement runs with a single snapshot. CTE queries (even with `SELECT ... FOR UPDATE`) cannot see sibling or concurrent commits made after the statement begins. Furthermore, unreferenced CTEs are completely optimized away or do not serialize subsequent operations.
- Neon HTTP driver does not support interactive transactions (`db.transaction(async tx => ...)`).
- **Repaired Solution:** We use Neon HTTP's atomic batch capability (`db.batch(...)` on Neon HTTP, `executeAtomicBatch` on postgres-js / local test harness).
  1. **Statement 1:** Acquires the row-level customer lock as an executed statement:
     `SELECT id FROM customer WHERE id = $customerId FOR UPDATE`.
  2. **Statement 2:** Executes in a *subsequent* statement within the *same* multi-statement transaction batch. Because Statement 1 committed its lock, Statement 2 evaluates under a fresh snapshot that sees any competing transaction's committed inquiry rows.
  3. Consistent lock acquisition order: all inquiry-creating or text-routing writers acquire the customer lock first, preventing deadlocks.

### Product Inquiries (`START_INQUIRY`)
- Constrained by partial unique index:
  `inquiry_active_per_customer_product_idx` ON `inquiry (customer_id, product_id) WHERE status IN ('open', 'waiting_on_customer')`.
- The resolution query checks for existing active inquiry. If found, returns existing inquiry without snapshot rewrite (`isResume = true`).
- If none exists, an `INSERT INTO inquiry ... ON CONFLICT (customer_id, product_id) WHERE status IN ('open', 'waiting_on_customer') DO NOTHING` executes.
- If concurrent writers race past Statement 1, the winner creates the inquiry while the other gets zero rows returned from INSERT and gracefully falls back to selecting the winning active inquiry, binding a valid receipt with non-null `inquiryId` and `reference`.
- The receipt update is executed together with a SQL fencing guard:
  `SELECT CASE WHEN (SELECT count(*) FROM receipt_update) != 1 THEN (1/0)::text ELSE 'ok' END`
  which immediately rolls back the batch if the attempt is stale or superseded.

### General Support (`OPEN_SUPPORT`)
- General support threads have `product_id = NULL`. Support category is `category = NULL` (general) or matches configured `support_category`.
- Under the customer row lock in Statement 1, Statement 2 selects active support inquiry for `customer_id = $customerId AND product_id IS NULL AND (category IS NOT DISTINCT FROM $category) AND status IN ('open', 'waiting_on_customer')`.
- If found, resumes without mutation (`isResume = true`).
- If none found, inserts new support inquiry with `product_id = NULL`, server-generated unique `reference`, and support snapshot `{ type: "support" }`.
- Concurrent support taps for the same customer serialize on the customer row lock, guaranteeing exactly one active thread per `(customerId, category)`.

---

## 2. Strict Write Fencing & Ownership Guards in SQL

- A stale or superseded worker attempt must create zero inquiries, zero messages, zero receipts, and mutate zero timestamps or statuses.
- In `appendInboundCustomerMessage` and `routeAndAppendCustomerText`:
  - Customer ownership and active status are verified inside the database query:
    `WHERE customer_id = $customerId AND status IN ('open', 'waiting_on_customer')`.
  - Stale attempt guard locks the update row:
    `SELECT id FROM telegram_update WHERE update_id = $updateId AND (payload->>'attemptId') = $attemptId FOR UPDATE`.
  - Both message insertion and inquiry timestamp update are gated by `WHERE EXISTS (SELECT 1 FROM locked_inquiry) AND EXISTS (SELECT 1 FROM locked_attempt)`.
  - Transaction rollback on stale attempt: The CTE includes a division-by-zero fencing guard that checks `receipt_update` affected row count. If `receipt_update` updated 0 rows (stale attempt or superseded claim), PostgreSQL aborts with `ERROR: division by zero`, rolling back all batch statements cleanly.
- No synthetic update IDs (e.g. `updateId: 0` / random attempt IDs) are allowed for state-changing inquiry callbacks; missing write context fails closed.

---

## 3. Atomic Zero-Active Free-Text Routing

- In Phase 07 initial implementation, `handleIncomingMessage` committed support creation in one transaction and then separately appended the customer message in a second transaction, leaving an orphaned support inquiry receipt if the second transaction failed.
- **Repaired Solution (`routeAndAppendCustomerText`):**
  - Ordinary inbound text routing runs as a single protected atomic operation under customer lock.
  - Resolves active inquiry count under customer lock:
    - **0 active inquiries:** Creates general support inquiry (`product_id = NULL, category = NULL`), inserts customer message, touches `lastCustomerMessageAt`, and writes message receipt in one transaction batch.
    - **1 active inquiry:** Directly appends customer message to the active inquiry, touches `lastCustomerMessageAt`, and writes message receipt in one transaction batch.
    - **>1 active inquiries:** Commits an ambiguous receipt (with active references) and returns guidance notice; zero message rows created.
    - **Stale attempt:** Fencing guard rolls back all writes cleanly; zero partial support threads created.

---

## 4. Callback Recovery from Committed Outcomes

- Telegram retries or network drops after database commit can cause callback query retries.
- Prior to PR #18 repairs, retries re-validated the live catalog and action hierarchy. If an admin disabled the product or action after the customer tapped, the retry failed with "action unavailable" instead of recovering the committed result.
- **Repaired Solution (`recoverAndRenderCommittedInquiryCallback`):**
  - Webhook intercepts committed callback queries before live action/hierarchy validation.
  - If a receipt exists on the claimed update (`receipt.kind === "inquiry"`):
    1. Fetches the inquiry by `receipt.inquiryId` and verifies customer ownership.
    2. If inquiry is closed, renders truthful closed notice.
    3. Reconstructs confirmation using the stored frozen `productSnapshot` and `selectedOptions` directly from the database.
    4. For support inquiries, renders the support confirmation (preserving configured category).
    5. Returns 200 without touching or revalidating modified catalog entities.

---

## 5. Text & Confirmation Contracts

- **Whitespace Preservation:** Customer message bodies preserve exact authored whitespace without trimming or stripping. For `/reply <REF> <body...>`, the reference is parsed cleanly, while customer body following the delimiter whitespace preserves all leading/trailing whitespace.
- **Multiline Slash Commands:** Any message starting with `/` (including multiline commands like `/cmd\ntext`) is treated as a command and returns guidance; zero message rows created.
- **Pagination of Active Inquiries (`inq:page`):** Active inquiries list is paginated (5 items per page) so customers with >10 active inquiries can reach all references via Next/Back buttons.
- **Transport Reliability:** `editOrThrow` falls back to `sendOrThrow` only for non-retryable `not_editable` errors ("message is not modified", "message to edit not found"). Transient errors (timeout, network, rate limits) throw to remain retryable.
