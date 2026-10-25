# Phase 07 Implementation Note: Durable Writes, Serialization, and Retries

## 1. Create/Resume Serialization Strategy

### Product Inquiries (`START_INQUIRY`)
- A customer product inquiry is uniquely constrained by the partial unique index:
  `inquiry_active_per_customer_product_idx` ON `inquiry (customer_id, product_id) WHERE status IN ('open', 'waiting_on_customer')`.
- Concurrency guard: A customer row lock (`SELECT id FROM customer WHERE id = $customerId FOR UPDATE`) is acquired at the start of the inquiry resolution query.
- The atomic CTE checks for an existing active inquiry for `(customerId, productId)`. If one exists, it is selected and resumed without modification (`isResume = true`). If none exists, an `INSERT INTO inquiry ... ON CONFLICT (customer_id, product_id) WHERE status IN ('open', 'waiting_on_customer') DO NOTHING` statement executes, returning the new row.
- If concurrent taps occur for the same customer and product, row serialization on the customer record ensures exactly one transaction creates the inquiry while the other resumes it. Even across distinct transactions, the partial unique index serves as a hard PostgreSQL constraint preventing duplicate active threads.

### General Support (`OPEN_SUPPORT`)
- General support threads have `product_id = NULL`. In PostgreSQL, `NULL != NULL` under standard unique indexes, so the partial unique index does not deduplicate NULL `product_id`.
- Concurrency serialization is therefore enforced via database row-level locking:
  `SELECT id FROM customer WHERE id = $customerId FOR UPDATE`.
- Within the same atomic query/transaction:
  1. Customer row is locked with `FOR UPDATE`.
  2. Active inquiry search executes for `customer_id = $customerId AND product_id IS NULL AND (category IS NOT DISTINCT FROM $category) AND status IN ('open', 'waiting_on_customer')`.
  3. If an active thread exists, it is returned directly (`isResume = true`).
  4. If none exists, a new support inquiry is inserted with `status = 'open'`, server-generated unique `reference`, and minimal support snapshot `{ type: "support" }`.
- Because the customer row lock is held until the transaction commits, concurrent requests for the same customer cannot race between the check and the insert. Exactly one active support thread per `(customerId, category)` is created.

---

## 2. Permanent Binding of Committed Updates to Business Receipts

- When an update produces a durable side effect (creating an inquiry, resuming an inquiry, or appending an inbound message), a server-generated **business receipt** is constructed.
- The business receipt format:
  - For inquiry creation/resumption:
    `{ kind: "inquiry", inquiryId: string, reference: string, isResume: boolean, status: string }`
  - For inbound customer message:
    `{ kind: "message", inquiryId: string, messageId: string, reference: string, body: string, telegramMessageId: number }`
  - For ambiguous inbound text (multiple active destinations):
    `{ kind: "ambiguous", activeReferences: string[] }`
  - For command guidance / rejected content:
    `{ kind: "guidance", text: string }`
- The receipt is stored inside `telegram_update.payload` under the server-controlled key `receipt`:
  `payload = jsonb_set(payload, '{receipt}', $receipt::jsonb)`.
- Fencing guard: The receipt write requires `update_id = $updateId AND payload->>'attemptId' = $attemptId`. Stale or expired workers cannot write receipts.

---

## 3. Atomic Commitment Boundaries

- Every state-changing operation executes as a single atomic transaction (via `executeAtomicBatch` / CTE):
  - For inbound message:
    `[INSERT into inquiry_message, UPDATE inquiry (touch lastReplyAt, status -> open), UPDATE telegram_update (record receipt)]`.
  - For inquiry create/resume:
    `[INSERT/RESUME inquiry, UPDATE telegram_update (record receipt)]`.
- If any statement in the batch fails, the entire transaction rolls back:
  - No orphaned `inquiry` or `inquiry_message` is created.
  - No receipt is stored in `telegram_update`.
  - The update remains in a clean state eligible for retry.
- A receipt is never recorded if message insertion or inquiry creation rolled back.

---

## 4. Retry Recovery Behavior

- When a worker fails after database commit (e.g., during Telegram network transport while sending confirmation or before marking the update processed), the attempt lease eventually expires or `markTelegramUpdateFailed` records a sanitized diagnostic.
- `markTelegramUpdateFailed` only writes `processing_error`; it preserves `payload` and any committed `receipt`.
- On retry, `claimTelegramUpdate` claims the lease with a new `attemptId`, explicitly preserving `payload->'receipt'`.
- The webhook checks `claimedRow.payload?.receipt`:
  - If a receipt exists: The worker bypasses business execution entirely. It does **not** insert another message, does **not** create another inquiry, does **not** evaluate alternative conversations, and does **not** reopen closed inquiries.
  - The worker delivers the response corresponding to the stored receipt and marks the update processed via `markTelegramUpdateProcessed`.
- This guarantees end-to-end idempotency even across partial network failures, worker crashes, or delayed retries.
