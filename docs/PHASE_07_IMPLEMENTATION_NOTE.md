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

### JSON Null vs. Missing Receipt Defect
- In PostgreSQL JSONB, `'{"receipt": null}'::jsonb -> 'receipt'` evaluates to `'null'::jsonb`.
- In SQL, `'null'::jsonb IS NOT NULL` evaluates to `TRUE` because `'null'::jsonb` is a non-null SQL value of type `jsonb` representing the JSON `null` literal. SQL `IS NOT NULL` only evaluates to `FALSE` when a key is completely missing from the object (yielding SQL `NULL`).
- In Rabet's update processing lifecycle, `claimTelegramUpdate` initializes update rows with the envelope:
  ```json
  {
    "update": ...,
    "attemptId": "...",
    "claimedAt": "...",
    "receipt": null
  }
  ```
- Therefore, a naive check `payload->'receipt' IS NOT NULL` rejected missing keys, but accepted the initial `receipt: null` value. If a business statement's receipt `UPDATE` was suppressed, corrupted, or failed to match rows, the assertion could pass falsely without recording a recoverable result.

### The Repaired Assertion Pattern
We parameterized `createReceiptAssertionQuery(db, updateId, attemptId, expectedKind)` to validate the receipt strictly in SQL:
```sql
WITH verified_receipt AS (
  SELECT count(*) AS cnt FROM telegram_update
  WHERE update_id = $updateId::bigint
    AND processed_at IS NULL
    AND payload->>'attemptId' = $attemptId::text
    AND jsonb_typeof(payload->'receipt') = 'object'
    AND (payload->'receipt'->>'kind') = ANY(ARRAY[$expectedKinds]::text[])
    AND CASE (payload->'receipt'->>'kind')
      WHEN 'inquiry' THEN
        jsonb_typeof(payload->'receipt'->'inquiryId') = 'string'
        AND length(trim(payload->'receipt'->>'inquiryId')) > 0
        AND (payload->'receipt'->>'inquiryId') != 'null'
        AND jsonb_typeof(payload->'receipt'->'reference') = 'string'
        AND length(trim(payload->'receipt'->>'reference')) > 0
        AND (payload->'receipt'->>'reference') != 'null'
      WHEN 'message' THEN
        jsonb_typeof(payload->'receipt'->'inquiryId') = 'string'
        AND length(trim(payload->'receipt'->>'inquiryId')) > 0
        AND (payload->'receipt'->>'inquiryId') != 'null'
        AND jsonb_typeof(payload->'receipt'->'messageId') = 'string'
        AND length(trim(payload->'receipt'->>'messageId')) > 0
        AND (payload->'receipt'->>'messageId') != 'null'
        AND jsonb_typeof(payload->'receipt'->'reference') = 'string'
        AND length(trim(payload->'receipt'->>'reference')) > 0
        AND (payload->'receipt'->>'reference') != 'null'
      WHEN 'ambiguous' THEN
        jsonb_typeof(payload->'receipt'->'activeReferences') = 'array'
      WHEN 'guidance' THEN
        jsonb_typeof(payload->'receipt'->'notice') = 'string'
        AND length(trim(payload->'receipt'->>'notice')) > 0
        AND (payload->'receipt'->>'notice') != 'null'
      ELSE false
    END
)
SELECT CASE
  WHEN (SELECT cnt FROM verified_receipt) = 1 THEN 'ok'
  ELSE CAST('ASSERTION_FAILED_MISSING_RECEIPT_' || (SELECT cnt FROM verified_receipt) AS date)::text
END AS assertion_status;
```

### Actual Assertion Guarantees
1. **Rejects JSON Null & Missing Keys:** `jsonb_typeof(payload->'receipt') = 'object'` requires a JSON object, strictly rejecting JSON `null` (where `jsonb_typeof` is `'null'`) and missing keys (where `jsonb_typeof` is SQL `NULL`).
2. **Rejects Non-Object Shapes:** Strictly rejects scalars (strings, numbers, booleans) and arrays.
3. **Rejects Empty Objects & Mismatches:** Rejects `{}` because `(payload->'receipt'->>'kind')` is NULL and cannot match the expected kinds. Rejects mismatched kinds (e.g. message receipt when expecting inquiry).
4. **Validates Recovery Invariants:** Validates kind-specific recovery fields (non-empty `inquiryId`, `reference`, `messageId`, `activeReferences`, `notice`).
5. **Execution Guarantee:** Because it is an executed statement in `db.batch` / `executeAtomicBatch`, its result is consumed by the driver. When `cnt != 1`, it casts `'ASSERTION_FAILED_MISSING_RECEIPT_0'` to `date`, which triggers PostgreSQL error code `22007` (`invalid input syntax for type date`), immediately aborting the batch and rolling back all prior statements.

### Proven Post-Mutation Rollback Under Real Claim Envelopes (Tests M, N & O)
Verified with real claimed updates (`receipt: null`) across both fault forms:
1. **Fault Form A (Suppression - Test M):** A temporary trigger returns `NULL` on receipt updates, skipping the update and leaving the initial `receipt: null` unchanged.
2. **Fault Form B (Corruption - Test N):** A temporary trigger allows the update but sets `NEW.payload = jsonb_set(NEW.payload, '{receipt}', 'null'::jsonb)`.
3. **Covered Operations:**
   - Support inquiry creation (`createOrResumeSupportInquiry`): Operation rejects; 0 inquiries survive in PostgreSQL.
   - Zero-active ordinary text (`routeAndAppendCustomerText` and webhook): Operation rejects; 0 inquiries and 0 messages survive; webhook returns 500; fake transport sends 0 messages (no false success acknowledgement).
   - Append to existing `waiting_on_customer` inquiry (`appendInboundCustomerMessage`): Operation rejects; 0 messages survive; existing inquiry status remains `waiting_on_customer` (never transitioned to `open`); timestamps (`updatedAt`, `lastReplyAt`) remain identical to baseline.
4. **Shape Matrix Coverage (Test O):** Tests 18 distinct valid and invalid receipt shapes directly against the assertion statement, proving all malformed shapes reject with `22007` and all valid outcomes resolve with `'ok'`.

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

## 7. Callback Recovery from Committed Outcomes & Transport Ambiguity Boundary

### Callback Recovery Contract
- Intercepts committed callbacks (`receipt.kind === "inquiry"`) before live action/hierarchy validation:
  1. Fetches the inquiry by `receipt.inquiryId` and verifies customer ownership.
  2. If closed, renders truthful closed notice.
  3. Reconstructs confirmation using the stored frozen `productSnapshot` and `selectedOptions` directly from the database.
  4. For support inquiries, renders the support confirmation (preserving configured category).
  5. Returns 200 without touching or revalidating modified catalog entities.

### External Telegram Delivery Ambiguity Boundary
- Database mutations and durable receipts commit together atomically.
- If network transport drops or times out after database commit, Telegram retries the webhook update.
- `claimTelegramUpdate` preserves the committed `payload.receipt`.
- On retry, Rabet reuses the committed receipt and delivers confirmation without re-executing business mutations, preventing duplicate inquiries or duplicate message rows.
