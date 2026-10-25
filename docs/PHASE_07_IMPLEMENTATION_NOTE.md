# Phase 07 Implementation Note: Durable Writes, Serialization, and Retries (PR #18)

## 1. Create/Resume Serialization Strategy (Repaired for Neon HTTP & PostgreSQL)

### The Single-Statement Snapshot Problem and Solution
- In PostgreSQL default `READ COMMITTED` isolation, every statement runs with a single snapshot. CTE queries (even with `SELECT ... FOR UPDATE`) cannot see sibling or concurrent commits made after the statement begins. Furthermore, unreferenced CTEs are completely optimized away or do not serialize subsequent operations.
- Neon HTTP driver does not support interactive transactions (`db.transaction(async tx => ...)`).
- **Repaired Solution:** We use Neon HTTP's atomic batch capability (`db.batch(...)` on Neon HTTP, `executeAtomicBatch` on postgres-js / local test harness).
  1. **Statement 1:** Acquires the row-level customer lock as an executed statement:
     `SELECT id FROM customer WHERE id = $customerId FOR UPDATE`.
  2. **Statement 2:** Executes in a *subsequent* statement within the *same* multi-statement transaction batch. Because Statement 1 acquired its lock, Statement 2 evaluates under a fresh snapshot that sees any competing transaction's committed inquiry rows.
  3. **Strict Lock Ordering:** Writers adhere to the strict hierarchy: `customer` -> `inquiry` -> `telegram_update`. This prevents deadlocks across concurrent customer actions and future seller lifecycle updates.

### Product Inquiries (`START_INQUIRY`)
- Constrained by partial unique index:
  `inquiry_active_per_customer_product_idx` ON `inquiry (customer_id, product_id) WHERE status IN ('open', 'waiting_on_customer')`.
- The resolution query checks for existing active inquiry. If found, returns existing inquiry without snapshot rewrite (`isResume = true`).
- If none exists, an `INSERT INTO inquiry ... ON CONFLICT (customer_id, product_id) WHERE status IN ('open', 'waiting_on_customer') DO NOTHING` executes.
- If concurrent writers race past Statement 1, the winner creates the inquiry while the other gets zero rows returned from INSERT and gracefully falls back to selecting the winning active inquiry, binding a valid receipt with non-null `inquiryId` and `reference`.
- The receipt update is verified via an executed atomic assertion statement `createReceiptAssertionQuery`.

### General Support (`OPEN_SUPPORT`)
- General support threads have `product_id = NULL`. Support category is `category = NULL` (general) or matches configured `support_category`.
- Under the customer row lock in Statement 1, Statement 2 selects active support inquiry for `customer_id = $customerId AND product_id IS NULL AND (category IS NOT DISTINCT FROM $category) AND status IN ('open', 'waiting_on_customer')`.
- If found, resumes without mutation (`isResume = true`).
- If none found, inserts new support inquiry with `product_id = NULL`, server-generated unique `reference`, and support snapshot `{ type: "support" }`.
- Concurrent support taps for the same customer serialize on the customer row lock, guaranteeing exactly one active thread per `(customerId, category)`.

---

## 2. Real Transaction Assertions & Proven Rollback (`createReceiptAssertionQuery`)

### Defect in CTE-Based Fencing Guards
- Previously, a CTE `fencing_guard` computed `CASE WHEN (SELECT count(*) FROM receipt_update) != 1 THEN (1/0)::text ELSE 'ok' END`.
- If the final outer projection (`SELECT ...`) does not consume or evaluate columns from that CTE, PostgreSQL optimizer can prune or bypass evaluating the expression. Furthermore, static division-by-zero or constant cast expressions may fail at query analysis/planning time or get optimized out.

### Runtime Aggregate Assertion Pattern
- We introduced `createReceiptAssertionQuery(updateId, attemptId)` as a dedicated executed statement within the atomic batch:
  ```sql
  SELECT CASE
    WHEN (
      SELECT count(*)
      FROM telegram_update
      WHERE update_id = $updateId
        AND (payload->>'attemptId') = $attemptId
        AND (payload->'receipt') IS NOT NULL
    ) = 1 THEN 'ok'
    ELSE CAST(
      'ASSERTION_FAILED_MISSING_RECEIPT_' || (
        SELECT count(*)
        FROM telegram_update
        WHERE update_id = $updateId
          AND (payload->>'attemptId') = $attemptId
          AND (payload->'receipt') IS NOT NULL
      ) AS date
    )::text
  END AS fence_status
  ```
- **Execution Guarantee:**
  1. Because it is a top-level statement in `db.batch` / `executeAtomicBatch`, its result is always consumed by the driver and cannot be skipped by an optimizer.
  2. Because the error expression references a runtime aggregate query (`count(*)` from `telegram_update`), PostgreSQL cannot evaluate or fold it during query preparation or planning.
  3. When `count(*) != 1` (stale attempt, missing receipt, or concurrent fence failure), PostgreSQL attempts to cast the string `'ASSERTION_FAILED_MISSING_RECEIPT_0'` to `date`. This immediately throws PostgreSQL error code `22007` (`invalid input syntax for type date`).
  4. In both Neon HTTP transactions and PostgreSQL connection adapters, this error immediately aborts the transaction batch and rolls back all prior mutations (including any inserted messages, created inquiries, or modified timestamps).

### Proven Post-Mutation Rollback (Test J)
- Verified with a controlled fault-injection test (`Test J` in `tests/db/customer-inquiries.test.ts`):
  - A temporary `BEFORE UPDATE` trigger on `telegram_update` intentionally clears `NEW.payload = jsonb_set(NEW.payload, '{receipt}', 'null'::jsonb)`.
  - When `routeAndAppendCustomerText` executes, the message insert and inquiry touches execute, but `createReceiptAssertionQuery` detects `count = 0` valid receipts.
  - The transaction aborts with `22007`.
  - Verification queries against PostgreSQL confirm:
    - 0 new inquiries created.
    - 0 messages inserted into `inquiry_message`.
    - No timestamps or statuses modified.
    - The batch rolled back completely.

---

## 3. Ordinary-Text Routing & Concurrent Inquiry Closure Protection

### Concurrency Hazard on Ordinary Text
- In ordinary text routing, a customer with 1 active inquiry sends text intended for that inquiry.
- If an admin or seller closes or resolves that inquiry concurrently while the text routing query is in flight, an unprotected query could append the customer message to a closed inquiry or mutate its `last_reply_at`, violating the contract that closed threads receive zero messages.

### Linearization Point & Locking Protocol
- In `routeAndAppendCustomerText`:
  1. **Statement 1:** Locks the customer row: `SELECT id FROM customer WHERE id = $customerId FOR UPDATE`.
  2. **Statement 2:** Resolves candidate active inquiries (`SELECT id, reference, status FROM inquiry WHERE customer_id = $customerId AND status IN ('open', 'waiting_on_customer') ORDER BY updated_at DESC, id DESC`).
  3. When candidate count is exactly 1:
     - CTE `locked_destination` locks the specific inquiry row:
       `SELECT id FROM inquiry WHERE id = $targetId AND status IN ('open', 'waiting_on_customer') FOR UPDATE`.
     - If a concurrent transaction closed the inquiry and committed while routing waited, `locked_destination` yields 0 rows upon acquisition.
     - `inserted_message` requires `WHERE EXISTS (SELECT 1 FROM locked_destination)`.
     - `updated_inquiry` requires `WHERE id IN (SELECT id FROM locked_destination) AND status IN ('open', 'waiting_on_customer') AND EXISTS (SELECT 1 FROM inserted_message)`.
     - `msg_receipt_update` requires `WHERE EXISTS (SELECT 1 FROM inserted_message)`.
     - If the inquiry was closed, 0 receipts are written, and `createReceiptAssertionQuery` triggers transaction rollback.
     - Result: Zero messages on the closed inquiry, zero timestamp mutation, and zero silent rerouting to a newly created support thread.
  4. Controlled independent-connection test (`Test I` in `tests/db/customer-inquiries.test.ts`) verifies this exact race condition: Connection 1 closes the destination inquiry while routing is in flight, and upon Connection 1's commit, routing fails safely without modifying the closed inquiry.
  5. The reverse ordering (message commits before closure begins) is also verified: message is appended, and subsequent closure successfully transitions the inquiry to `closed`.

---

## 4. First-Message Metadata & Trigger Safety

### First Support Message Metadata
- When ordinary text creates a new general support inquiry (0 active inquiries), `created_support` explicitly initializes both `last_customer_message_at = now()` and `last_reply_at = now()`.
- Verified directly on database rows (`Test K` in `tests/db/customer-inquiries.test.ts`), ensuring seller views or pagination queries sorting by `last_reply_at` or `updated_at` immediately observe the first inbound message.

### Avoiding Accidental Trigger Firings on Duplicate Deliveries
- The database has an active trigger `inquiry_touch_updated_at` (`BEFORE UPDATE ON inquiry FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`).
- In `routeAndAppendCustomerText` and `appendInboundCustomerMessage`:
  - `updated_inquiry` includes `AND EXISTS (SELECT 1 FROM inserted_message)`.
  - On a duplicate delivery (where the message already exists and `inserted_message` produces 0 rows), `updated_inquiry` executes 0 row updates.
  - This prevents `inquiry_touch_updated_at` from firing, preserving `updated_at` and `last_reply_at` exactly without false advancement.

---

## 5. Command Recognition & Whitespace Preservation

### Normalized Command Parsing (`inquiry-journey.ts`)
- Regular expression: `/^\s*\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s*([\s\S]*))?$/`
  - Captures leading whitespace properly, preventing bypasses like `"   /unknowncmd\nline2"`.
  - Commands with leading whitespace or multiline bodies are strictly recognized as slash commands and return safe `/start` guidance; zero messages are stored.
  - Distinguishes `/reply` from unrelated commands starting with reply (e.g. `/replyall`), treating `/replyall` as an unknown command rather than malformed `/reply`.
  - For valid `/reply <REF> <body...>`, extracts the reference cleanly while preserving the exact authored whitespace of `body` following the single delimiter space.
  - Non-command text preserves exact `rawText` whitespace without trimming.

---

## 6. Deterministic Pagination of Active Inquiries (`inq:page`)

- In `listActiveCustomerInquiriesPaged`, the order clause is:
  `.orderBy(desc(inquiry.updatedAt), desc(inquiry.id))`
- Adding the secondary tie-breaker `desc(inquiry.id)` ensures deterministic pagination across pages even when inquiries share identical `updated_at` microsecond timestamps.

---

## 7. Callback Recovery from Committed Outcomes

- Intercepts committed callbacks (`receipt.kind === "inquiry"`) before live action/hierarchy validation:
  1. Fetches the inquiry by `receipt.inquiryId` and verifies customer ownership.
  2. If closed, renders truthful closed notice.
  3. Reconstructs confirmation using the stored frozen `productSnapshot` and `selectedOptions` directly from the database.
  4. For support inquiries, renders the support confirmation (preserving configured category).
  5. Returns 200 without touching or revalidating modified catalog entities.

---

## 8. Live Telegram Verification Boundaries

- Automated test suites (34 tests in `customer-inquiries.test.ts`, 61 in `telegram-journey.test.ts`, transport and token tests) run against PostgreSQL test instances.
- **Live Bot Scope:** Real Telegram interactions with live bot tokens depend on configured webhook endpoints and active bot tokens.
- Boundaries verified:
  - Valid private chat callbacks produce prompt visual confirmations and inline keyboards.
  - Inbound text with single active inquiry acknowledges truthfully without false seller promises.
  - Ambiguous inbound text prompts cleanly with paginated button menus.
  - Multiline commands and media types (photos, documents) fail safely with localized notices.
