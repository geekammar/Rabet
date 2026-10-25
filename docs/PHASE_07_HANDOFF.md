# Phase 07 Handoff: Unified Customer Inquiries, Support & Inbound Messages (PR #18)

## 1. Overview and Scope

Phase 07 delivers the customer-facing inquiry and conversation foundation for Rabet within the unified database schema:
1. `START_INQUIRY` Action: Customers start or resume a product-tied conversation from a product action button. Captures immutable product snapshot (localized name, exact decimal price, currency, root-to-leaf category ancestry) and root-to-leaf option ancestry (`selected_options`).
2. `OPEN_SUPPORT` Action: Customers start or resume general support (`product_id = NULL, category = NULL`) or category-specific support, validating configured support categories against active `bot_setting.support_category` entries.
3. Inbound Text Routing: Processes customer text messages in private Telegram chats:
   - `/reply <REFERENCE> <message>`: Deterministically routes text to the customer's own active inquiry with exact whitespace preservation on customer text.
   - Ordinary text with 1 active inquiry: Appends message to that active thread.
   - Ordinary text with 0 active inquiries: Atomically creates/resumes general support (`category = NULL`) and saves the message in one protected transaction.
   - Ordinary text with >1 active inquiries: Fails closed without saving, prompting the customer with their active reference list and `/reply` syntax (paginated with `inq:page` buttons).
   - Command priority: `/start` triggers catalog browsing; unknown slash commands (single or multiline) return guidance and are never stored.
4. Durable Update Receipts, Serialization & Idempotency:
   - Serializes create/resume via executed customer row locks (`FOR UPDATE`) in atomic multi-statement batches (`db.batch` / `executeAtomicBatch`).
   - Guarantees attempt ownership and active destination status in SQL, rolling back via fencing guard if stale.
   - Recovers committed receipts on retry before live action/hierarchy validation, rendering frozen snapshots even if catalog items were subsequently modified or deactivated.

**Explicit Scope Exclusions (Deferred to Later Phases):**
- Seller inbox, web dashboard, and seller replies belong to **Phase 09**.
- Admin manual lifecycle controls and seller Telegram notifications are not in this slice.
- Non-text media (photos, voice, documents, audio, stickers, uploads) are rejected with safe guidance; zero empty message rows are written.
- Orders, checkout, payments, and billing belong to future phases or remain deferred.
- No seller response times or seller read receipts are promised to the customer.

---

## 2. Architecture & Data Model Contracts

### 2.1 Unified Inquiry Model
Both product inquiries and general support share the `inquiry` table:
- **Product Inquiries:**
  - `product_id` is set to the source product's UUID.
  - Guarded by the partial unique index `inquiry_active_product_idx` on `(customer_id, product_id) WHERE status IN ('open', 'waiting_on_customer')`.
  - Exactly one active inquiry per customer and product is permitted at any time.
- **Support Inquiries:**
  - `product_id = NULL`.
  - `category` is `NULL` for general support, or a non-empty string matching one of the store's configured `support_categories`.
  - Deduplication is serialized at the data layer using customer row locking (`FOR UPDATE`) in an executed batch statement.
  - Different support categories maintain distinct active conversation identities.

### 2.2 Immutable Snapshots
- `product_snapshot` is frozen upon inquiry creation:
  - `name`: Localized product name at creation time.
  - `price`: Exact stored decimal price string (e.g. `"150.00"`). Never converted to float.
  - `currency`: Configured currency (e.g. `"USD"`).
  - `categoryPath`: Array of ancestor category localized names from root to immediate parent.
- `selected_options`: Array of localized labels representing the option ancestor chain from root action down to the tapped action. The terminal "Ask seller" label is distinguished and excluded from option ancestry.
- **Immutability Contract:** Snapshots are frozen at creation and never rewritten on resume or when catalog details/prices change. Database triggers prevent mutation of `product_snapshot`, `selected_options`, `customer_id`, and `product_id` on existing inquiry rows.

### 2.3 Reference Format
- Server-generated reference string: `INQ-` followed by 6 base-32 uppercase alphanumeric characters (excluding confusing characters like `0`, `O`, `1`, `I`), generated via cryptographically secure random bytes (`crypto.randomBytes`). Example: `INQ-7K9M2X`.

---

## 3. Inbound Text Message Routing Logic

Customer private chat messages are routed through `handleIncomingMessage`:

```
                           Incoming Private Chat Text
                                      │
                 ┌────────────────────┴────────────────────┐
                 ▼                                         ▼
         Starts with '/'                          Non-Command Text
                 │                                         │
       ┌─────────┴─────────┐                               ▼
       ▼                   ▼                     Active Inquiries Count?
   /start               /reply                             │
 (Catalog)                 │                     ┌─────────┼─────────┐
                           ▼                     ▼         ▼         ▼
                    Valid Syntax?              0 Active 1 Active  >1 Active
                    /reply <REF> <text>          │         │         │
                           │                     │         │         ▼
                   ┌───────┴───────┐             │         │    Ambiguous:
                   ▼               ▼             │         │    No write.
               Yes: Own        No/Unknown:       │         │    Prompt with
              Active Ref?      Show safe         │         │    references &
                   │            guidance.        │         │    /reply syntax
                   ▼            Zero write.      │         │
             Append message                      │         ▼
             to that inquiry                     │    Append message
                                                 │    to that inquiry
                                                 ▼
                                        Single Atomic Batch:
                                        Create support + append message
```

### 3.1 Commands
- `/start`: Preserved for catalog browsing and language selection.
- `/reply <REFERENCE> <message>`: Case-insensitive reference lookup scoped exclusively to the authenticated Telegram customer.
  - Whitespace after the single delimiter separating reference and message is preserved exactly as authored.
  - Must match an active inquiry (`open` or `waiting_on_customer`).
  - Unknown references, references belonging to other customers, or closed/resolved inquiries return safe guidance.
  - Never reveals whether an inquiry reference exists for another customer.
- Unknown slash commands (including multiline strings): Return safe localized command guidance; text is never saved to conversations.

### 3.2 Non-Command Text
- **0 Active Inquiries:** Transparently creates general support inquiry (`category = NULL`), appends message, updates timestamps, and writes receipt in a single atomic transaction (`routeAndAppendCustomerText`).
- **1 Active Inquiry:** Appends message directly to that active thread, touches `last_customer_message_at`, sets status to `open`, and writes receipt in a single atomic transaction.
- **>1 Active Inquiries:** Halts routing without persisting message. Records ambiguous receipt, responds with localized guidance, and lists active references (paginated via `inq:page` when >5 inquiries exist).

### 3.3 Message Validation & Rejection
- Blank or whitespace-only messages: Rejected with localized guidance; zero message rows created.
- Overlong messages (>4096 characters): Rejected with safe localized guidance; never silently truncated.
- Non-text content (photos, voice notes, stickers, documents): Rejected with localized "text messages only in this version" guidance; zero empty message rows created.
- Non-private chat updates: Ignored safely without writes.

---

## 4. Durable Update Receipts, Serialization & Idempotency

### 4.1 Update Receipt Binding
Committed business outcomes are bound to `telegram_update.payload.receipt` within the same atomic execution:
- Product inquiry receipt: `{ kind: "inquiry", inquiryId, reference, isResume, status, productId, category }`
- Support inquiry receipt: `{ kind: "inquiry", inquiryId, reference, isResume, status, productId: null, category }`
- Inbound message receipt: `{ kind: "message", inquiryId, messageId, reference, telegramMessageId, isNewSupport? }`
- Ambiguous routing receipt: `{ kind: "ambiguous", activeReferences }`
- Guidance receipts: `{ kind: "guidance", notice }`

### 4.2 Database Serialization & Neon HTTP Batch
- **Customer Lock as Executed Statement:** Executed prior to inquiry query in `executeAtomicBatch` / `db.batch`. Statement 2 runs with a fresh snapshot in READ COMMITTED isolation that observes competing commits.
- **SQL Fencing Guard:** Checks `receipt_update` row count. If 0 rows are affected (stale attempt or superseded claim), aborts via division-by-zero trigger, guaranteeing atomic rollback of all batch mutations.
- **Callback Recovery:** Intercepts committed callbacks before live action validation. Recovers frozen snapshot from database and renders confirmation even if products or actions were subsequently modified or disabled.

---

## 5. Verification and Test Suite

| Test Suite | File | Tests | Status |
| --- | --- | --- | --- |
| Customer Inquiries Unit, Integration & Concurrency | `tests/db/customer-inquiries.test.ts` | 30 | Passed |
| Telegram Journey Integration | `tests/db/telegram-journey.test.ts` | 61 | Passed |
| Telegram Transport | `tests/telegram-transport.test.ts` | 24 | Passed |
| Telegram Tokens | `tests/telegram-tokens.test.ts` | 5 | Passed |
| Database Integration (All Suites) | `tests/db/*.test.ts` (17 files) | 268 | Passed |
| Unit, Auth & Wizard Suites | `tests/**/*.test.ts` | 503 | Passed |

All tests run on real PostgreSQL with strict schema migrations and trigger checks. Linting, TypeScript typechecking, and Next.js production build (`env -u DATABASE_URL npm run build`) pass cleanly with 0 errors and 0 warnings.
