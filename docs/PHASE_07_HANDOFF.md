# Phase 07 Handoff: Unified Customer Inquiries, Support & Inbound Messages

## 1. Overview and Scope

Phase 07 delivers the customer-facing inquiry and conversation foundation for Rabet within the unified database schema:
1. `START_INQUIRY` Action: Customers start or resume a product-tied conversation from a product action button. The action captures an immutable product snapshot (localized name, exact decimal price, currency, root-to-leaf category ancestry) and root-to-leaf option ancestry (`selected_options`).
2. `OPEN_SUPPORT` Action: Customers start or resume general support or category-specific support (`product_id = NULL`), validating configured support categories against active `bot_setting.support_category` entries.
3. Inbound Text Routing: Processes customer text messages in private Telegram chats:
   - `/reply <REFERENCE> <message>`: Deterministically routes text to the customer's own active inquiry.
   - Ordinary text with 1 active inquiry: Appends message to that active thread.
   - Ordinary text with 0 active inquiries: Automatically creates/resumes general support (`category = NULL`) and saves the message.
   - Ordinary text with >1 active inquiries: Fails closed without saving, prompting the customer with their active reference list and `/reply` syntax.
   - Command priority: `/start` triggers catalog browsing; unknown slash commands return guidance and are never stored.
4. Durable Update Receipts & Idempotency: Stores committed business outcomes directly in `telegram_update.payload.receipt`, serialized via customer row locking (`FOR UPDATE`) and guaranteed by the partial unique index on active product inquiries. Retries recover committed receipts, preventing duplicate inquiries or duplicate messages across network retries.

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
  - General support (`category = NULL`) deduplication is handled at the data layer using customer row locking (`FOR UPDATE`) during create/resume.
  - Different support categories maintain distinct active conversation identities.

### 2.2 Immutable Snapshots
- `product_snapshot` is frozen upon inquiry creation:
  - `name`: Localized product name at creation time.
  - `price`: Exact stored decimal price string (e.g. `"150.00"`). Never converted to float.
  - `currency`: Configured currency (e.g. `"USD"`).
  - `categoryPath`: Array of ancestor category localized names from root to immediate parent.
- `selected_options`: Array of localized labels representing the option ancestor chain from root action down to the tapped action. The terminal "Ask seller" label is distinguished and excluded from option ancestry.
- **Immutability Contract:** Snapshots are frozen at creation and never rewritten on resume or when catalog details/prices change. Database triggers prevent mutation of `product_snapshot`, `customer_id`, and `product_id` on existing inquiry rows.

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
                                        Create/resume general
                                        support and append message
```

### 3.1 Commands
- `/start`: Preserved for catalog browsing and language selection.
- `/reply <REFERENCE> <message>`: Case-insensitive reference lookup scoped exclusively to the authenticated Telegram customer.
  - Must match an active inquiry (`open` or `waiting_on_customer`).
  - Unknown references, references belonging to other customers, or closed/resolved inquiries return safe guidance (`"Could not find an active inquiry with reference..."` / `"لم نتمكن من العثور على استفسار نشط بهذا المرجع"`).
  - Never reveals whether an inquiry reference exists for another customer.
- Unknown slash commands: Return safe localized command guidance; text is never saved to conversations.

### 3.2 Non-Command Text
- **0 Active Inquiries:** Transparently creates or resumes a general support inquiry (`category = NULL`) and appends the message.
- **1 Active Inquiry:** Appends the message directly to that active thread (product or support). Touches `last_customer_message_at` and sets status to `open`.
- **>1 Active Inquiries:** Halts routing without persisting the message. Responds with localized guidance explaining that multiple conversations are active, lists the customer's active references with short context, and provides exact `/reply <REFERENCE> <message>` instructions.

### 3.3 Message Validation & Rejection
- Blank or whitespace-only messages: Rejected with localized guidance; zero message rows created.
- Overlong messages (>4096 characters): Rejected with safe localized guidance; never silently truncated.
- Non-text content (photos, voice notes, stickers, documents): Rejected with localized "text messages only in this version" guidance; zero empty message rows created.
- Non-private chat updates: Ignored safely without writes.

---

## 4. Durable Update Receipts, Serialization & Idempotency

### 4.1 Update Receipt Binding
Committed business outcomes are bound to `telegram_update.payload.receipt` within the same atomic execution:
- Product inquiry receipt: `{ kind: "product_inquiry", inquiryId, reference, resumed }`
- Support inquiry receipt: `{ kind: "support_inquiry", inquiryId, reference, category, resumed }`
- Inbound message receipt: `{ kind: "inbound_message", inquiryId, messageId, reference }`
- Ambiguous routing receipt: `{ kind: "ambiguous_message_guidance", activeCount }`
- Error / Ignored receipts: `{ kind: "ignored" | "rejected", reason }`

### 4.2 Database Serialization
- Customer Row Locking: `SELECT id FROM customer WHERE id = $1 FOR UPDATE` within atomic multi-statement queries serializes concurrent requests for the same customer.
- Product Partial Unique Index: `inquiry_active_product_idx` acts as a definitive PostgreSQL-level concurrency barrier.
- Attempt Ownership: Update receipts and messages are written with attempt ID validation.
- Retry Recovery: When Telegram retries delivery of an update (e.g. after a network timeout during outbound reply transport), `claimTelegramUpdate` preserves the committed `payload.receipt`. The webhook inspects the recovered receipt and replays the response without creating duplicate inquiries, appending duplicate messages, or rerouting to other conversations.

---

## 5. Localization & Global Template Integration

- **Language Resolution:**
  1. Customer's explicit `selected_language_id`.
  2. If unset, customer's Telegram `language_code` matched against enabled store languages.
  3. Store default language fallback.
- **Global Templates:**
  - Product inquiry received: Reuses canonical `inquiry_received` template with placeholder interpolation (`{{store_name}}`, `{{product_name}}`, `{{price}}`, `{{customer_name}}`).
  - Support inquiry received: Reuses canonical `support_received` template.
  - Safe localized fallbacks for both English and RTL Arabic if templates are unconfigured or unavailable.
- **Truthful Tone:** Confirmation messages never state or imply that the seller was notified, has read the message, or will respond within a specific timeframe.

---

## 6. Verification and Test Suite

| Test Suite | File | Tests | Status |
| --- | --- | --- | --- |
| Customer Inquiries Unit & Integration | `tests/db/customer-inquiries.test.ts` | 22 | Passed |
| Telegram Journey Integration | `tests/db/telegram-journey.test.ts` | 23 | Passed |
| Full Test Suite | All tests | 112 | Passed |

All tests run on real PostgreSQL with strict schema migrations and trigger checks. Linting, TypeScript typechecking, and Next.js production build (`env -u DATABASE_URL npm run build`) pass cleanly with 0 errors and 0 warnings.
