# Phase 06-A Handoff: Secure Telegram Webhook & First Catalog Journey

## 1. Overview and Intent

Phase 06-A delivers the first bounded customer-facing Telegram journey in the existing Rabet application:
```
Private Telegram chat -> /start -> welcome/language choice -> root catalog -> nested category -> product card with displayed price -> product action submenu -> SHOW_DETAILS -> Back/Home
```

This implementation reuses the existing configured store settings, supported languages, global message templates, categories, products, and recursive product action trees.

**Phase Scope Boundary:**
This is strictly **Phase 06-A**, the first secure customer browsing journey. It does **not** mark the entirety of Phase 06 or the Rabet MVP complete. Inquiries, seller inbox, live webhook activation, and checkout remain separate or deferred.

---

## 2. Route and Module Responsibilities

The implementation enforces a clean separation of concerns without introducing generic workflow engines or external queues:

```
src/
├── app/api/telegram/webhook/route.ts   # Next.js App Router POST webhook endpoint
├── lib/telegram/
│   ├── types.ts                       # Telegram Bot API updates, error classification, deadline & transport contracts
│   ├── tokens.ts                      # Strict <= 64-byte UTF-8 callback token encoder/parser with grammar validation
│   ├── transport.ts                   # Injected transport interface, fetch client with timeouts & sanitization, fake test transport
│   ├── catalog-journey.ts             # Navigation state-machine, visibility validation, localization, text chunking & preservation
│   └── webhook.ts                     # Request authentication, upfront validation, atomic dedup/claim, budget tracking, dispatch
├── lib/data/
│   ├── customer.ts                    # Minimal customer upsert and language preference persistence
│   └── telegram.ts                    # telegram_update atomic claim ownership, lease recovery, and attempt tracking
```

### 2.1 Webhook Authentication and Safety Boundary
- **Route:** `POST /api/telegram/webhook`.
- **Runtime:** Node.js runtime (App Router).
- **Session Exemption:** Configured in `src/proxy.ts` so the webhook is reachable without an admin session. Admin routes remain strictly guarded.
- **Request Authentication:** Incoming requests must present the secret token header `X-Telegram-Bot-Api-Secret-Token`. Validated using constant-time comparison (`crypto.timingSafeEqual`).
- **Fail-Closed Guarantee:** Missing configuration (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`) or invalid/missing secret tokens immediately fail closed (HTTP 503 / 401) with sanitized JSON responses and perform zero database writes and zero outbound HTTP calls.
- **Build Isolation:** The build succeeds without a database or Telegram credentials (`env -u DATABASE_URL npm run build`). No database connections or Telegram endpoints are queried at module evaluation time.
- **Secret & Privacy Protection:** Bot tokens, database connection URLs, secret headers, customer message bodies, raw SQL, and raw exception objects are never returned in public HTTP responses or logged. Public responses use fixed strings (`"Internal server error"`, `"Bad request"`, `"Unauthorized"`, `"Too Many Requests"`, `"Service Unavailable"`, `"Telegram webhook is not configured."`).

---

## 3. Upfront Input Validation Before Claim & Business Writes

To prevent junk data or corrupt tokens from entering the persistence layer, all runtime validation runs **before** calling `claimTelegramUpdate` or `upsertCustomer`:

1. **Identifier Safety & Bounds:**
   - `update_id`, `message.message_id`, `message.chat.id`, and `from.id` must be integers within safe integer bounds (`[1..Number.MAX_SAFE_INTEGER]`).
   - Fractional IDs (e.g. `123.45`), negative values (`-1`), non-numbers, or overflow numbers are immediately rejected with HTTP 400 Bad request.
2. **Private Chat & Nested Fields:**
   - Supported message updates require `chat.type === "private"`, `from` object with valid `id`, and string `text`. Non-string text or missing fields are rejected with 400.
   - Non-private chat types (groups, channels) and unsupported update shapes (e.g. `channel_post`, `inline_query`) are safely ignored with HTTP 200 without creating database rows or outbound calls.
3. **Contradictory Update Shapes:**
   - Updates containing contradictory supported shapes (e.g. both `message` and `callback_query` populated simultaneously) are rejected upfront with HTTP 400.
4. **Callback Query Token Grammar & UUIDs:**
   - `callback_query.data` is validated against Telegram's 1–64 UTF-8 byte limit.
   - Grammar is strictly parsed upfront: tokens must match recognized prefixes (`home`, `c:root`, `lang:<code>`, `c:<uuid>`, `p:<uuid>`, `a:<uuid>`, `m:<uuid>`, `b:<uuid>`).
   - Category, product, and action identifiers must conform to canonical 8-4-4-4-12 hex UUID grammar. Page numbers must be valid integers (`[1..99999]`).
   - Out-of-spec or unparseable callbacks fail upfront with HTTP 400.
5. **Zero Dirty Writes Guarantee:**
   - Any validation failure results in HTTP 400 and performs **zero database writes** in `telegram_update`, **zero customer writes** in `customer`, and **zero transport calls**.

---

## 4. Atomic Retry Ownership, Attempt Lifecycle & Execution Budget

The webhook deduplication and retry mechanism is database-backed and compatible with the production Neon HTTP driver (where interactive multi-query transactions or session locks are not available):

### 4.1 Attempt Claiming Protocol (`claimTelegramUpdate`)
1. **Initial Attempt:** Uses `INSERT INTO telegram_update (update_id, update_type, payload) VALUES (...) ON CONFLICT DO NOTHING RETURNING ...`.
   - If a row is inserted, the attempt acquires ownership (`status: "claimed"`).
2. **Concurrent Claim Contention & Retryable In-Flight Response Policy:**
   - If a competing delivery arrives while an active owner holds the lease, `claimTelegramUpdate` returns `status: "in_flight"`.
   - The webhook returns **HTTP 429 (Too Many Requests)** with header `Retry-After: 5` and `{ error: "Update is currently in flight" }`.
   - **Why HTTP 429 instead of HTTP 200:** Returning HTTP 200 on in-flight updates would cause Telegram to acknowledge delivery even if the active owner crashed shortly after. Returning HTTP 429 signals to Telegram to retry delivery if the current owner fails or abandons, while preserving **zero duplicate work** because the competing worker exits without processing.
   - **Delivery Timing Nuance:** A non-2xx response requests redelivery from Telegram. Telegram is not guaranteed or promised to honor `Retry-After` as an exact delivery schedule; our handler exposes retry timing recommendations, not an internal durable scheduler.
3. **Atomic Retry / Lease Recovery:**
   - When an update previously failed (`processing_error IS NOT NULL`) or an in-flight attempt was abandoned past the lease window (`> 30s`), a worker claims ownership via a single conditional atomic update:
   ```sql
   UPDATE telegram_update
   SET payload = :envelope, processing_error = NULL
   WHERE update_id = :updateId
     AND processed_at IS NULL
     AND (
       processing_error IS NOT NULL
       OR (payload->>'claimedAt') IS NULL
       OR (payload->>'claimedAt')::timestamptz <= :leaseCutoff
     )
   RETURNING *;
   ```
   PostgreSQL row-level write serialization guarantees that across concurrent retry deliveries, **exactly one** worker succeeds and acquires ownership (`status: "claimed"`). The runner receives `status: "in_flight"` (HTTP 429).
4. **Attempt Identity & Stale Attempt Protection:**
   - Each claim stamps a unique `attemptId` (UUID) into `payload->>'attemptId'`.
   - `markTelegramUpdateProcessed(db, { updateId, attemptId })` updates `processed_at` only `WHERE payload->>'attemptId' = :attemptId`.
   - `markTelegramUpdateFailed(db, { updateId, attemptId, errorMessage })` updates `processing_error` only `WHERE payload->>'attemptId' = :attemptId`.
   - A stale attempt superseded by a newer retry attempt cannot mark the record processed or overwrite newer attempt diagnostics.
5. **Execution Budget Tracker (`StandardExecutionDeadline`):**
   - Consistent with the 30-second lease window, each webhook execution is bounded by an execution budget (`DEFAULT_EXECUTION_BUDGET_MS = 25_000`, 25 seconds).
   - Remaining budget is tracked across database calls, catalog queries, and outbound HTTP requests.
   - If the budget expires during execution, `deadline.checkOrThrow()` throws `BudgetExceededError`, halting any further outbound sends.
   - Returns HTTP 503 (Service Unavailable) with `Retry-After: 5` and stores allowlisted safe diagnostic `category=budget_exceeded`.
   - **Deadline Scope:** The execution deadline prevents new Telegram requests from initiating after expiry and bounds transport fetch calls; it does not cancel already in-progress database driver queries.
6. **Completion Fencing Result Enforcement:**
   - The result of `markTelegramUpdateProcessed` is strictly checked. If it returns `false` (e.g. lease expired and another worker reclaimed ownership), the handler throws `FencingRejectedError`.
   - The rejected completion returns HTTP 500/503 and records failure, preventing stolen work from reporting misleading success.
7. **Delivery Ambiguity Boundary:**
   - Attempt fencing and deadlines minimize duplicate execution risk, but external HTTP delivery to Telegram and database completion are not physical-atomically committed across all possible crash windows. Single-owner attempt execution, stale-attempt fencing, and idempotency provide robust bounded safety without heavyweight external queue infrastructure.

---

## 5. Callback Acknowledgement, Rate Limiting & Safe Persisted Diagnostics

### 5.1 Callback Query Failure Policy & Expired Acknowledgement Recovery
- In Telegram Bot API, tapping an inline button displays a client loading spinner that stops when `answerCallbackQuery` is received.
- `answerCallbackQuery` results are **never silently ignored**.
- **Expired Query Recovery Policy:**
  - Telegram Bot API expires callback query tokens after ~30–60 seconds, returning HTTP 400 with `query is too old and response timeout expired or query id is invalid`.
  - On a legitimate redelivery/retry (e.g. if the initial callback acknowledgement succeeded but message editing failed due to a network glitch), `answerCallbackQuery` will now fail because the query has expired.
  - The transport narrowly classifies HTTP 400 with description containing `"query is too old"` strictly on `answerCallbackQuery` (never on `sendMessage` or `editMessageText`) as `errorKind: "callback_expired"`.
  - For this narrowly classified terminal acknowledgement condition, the handler allows the customer's intended read-only catalog rendering (e.g. `editMessageText`) to proceed under the existing attempt ownership and execution deadline.
  - The failed acknowledgement itself is **not** treated as successful (`ack.ok` remains false); the update is marked `processed_at` only after catalog rendering and completion fencing succeed.
  - Acknowledgement network errors, timeouts, rate limits, and unrecognized API errors continue to fail and trigger normal retry mechanics.
- **Single-Ack Back Routing:**
  - Back-button routing (`b:<actionId>`) directly invokes the destination view renderers (`handleActionExecution` for parent submenus or `renderProductCard` for root product cards) rather than recursively calling `handleCallbackQuery`. This completely eliminates redundant duplicate callback query acknowledgements during a single customer interaction.

### 5.2 Rate Limiting (`HTTP 429` & `Retry-After`)
- When Telegram API returns 429 (Too Many Requests) with `parameters.retry_after`, the transport parses `retryAfterSeconds`.
- The webhook preserves this timing: returns HTTP 429 with header `Retry-After: <seconds>`, avoiding conflicting immediate retries.
- Persisted diagnostic retains structured rate-limit data: `category=rate_limited;status=429;retry_after=<seconds>`.

### 5.3 Allowlisted Safe Diagnostics Schema
`processing_error` never stores raw exception messages, query strings, SQL statements, connection credentials, or customer message bodies. All caught errors are classified into allowlisted structured categories:

| Diagnostic Pattern | Meaning | Example |
| --- | --- | --- |
| `category=timeout` | Outbound HTTP timeout or AbortSignal triggered | `category=timeout` |
| `category=network_error` | Network disconnect, DNS failure, or socket reset | `category=network_error` |
| `category=rate_limited;status=429;retry_after=N` | Telegram Bot API rate limiting with retry window | `category=rate_limited;status=429;retry_after=8` |
| `category=budget_exceeded` | Worker reached 25s execution budget before completion | `category=budget_exceeded` |
| `category=fencing_rejected` | Worker completed work after losing attempt lease | `category=fencing_rejected` |
| `category=callback_expired` | Terminal expired callback token on answerCallbackQuery | `category=callback_expired` |
| `category=api_error` | Other Telegram Bot API error status (4xx/5xx) | `category=api_error` |
| `category=db_error` | Database constraint or query execution error | `category=db_error` |
| `category=internal_error` | Unexpected internal exception | `category=internal_error` |

Synthetic privacy tests verify that injected raw SQL, synthetic API secrets, bot tokens, webhook secrets, and customer message text never appear in HTTP responses or in `telegram_update.processing_error`.

---

## 6. Long Message Content Preservation & Sequential Chunking

Telegram Bot API enforces a hard ceiling of **4096 code units** per message text. Silent truncation drops critical disclosures or catalog text without merchant or customer awareness.

### 6.1 Unicode-Safe Chunking (`splitMessageText`)
- `splitMessageText(text, maxChunkLength = 4096)` splits text into sequential chunks each `<= 4096` code units.
- **Content Integrity Guarantee:** `chunks.join("") === text` (no characters or disclosures dropped).
- **Surrogate Pair Safety & Chunking Boundaries:** Never splits inside UTF-16 surrogate pairs (e.g. standard 2-code-unit emoji pairs like `\uD83D\uDE00` or multibyte Arabic graphemes). If index lands on a high surrogate, the split point shifts backward by 1 code unit. (Note: chunking guarantees exact text preservation and surrogate-pair integrity, but does not claim atomic encapsulation for every arbitrary multi-codepoint Unicode grapheme cluster such as complex ZWJ emoji sequences spanning across chunk boundaries).
- **Natural Boundary Preference:** Breaks cleanly on paragraph breaks (`\n\n`), then line breaks (`\n`), then word spaces (` `), falling back to hard split only when no delimiter exists within the 400-character window.

### 6.2 Sequential Delivery Order & Navigation Placement
- In `editOrThrow`:
  1. Chunk 0 edits the existing Telegram message (or sends if message was not editable).
  2. If only 1 chunk exists, inline keyboard navigation is attached immediately.
  3. If multiple chunks exist, chunk 0 has no reply markup; follow-up chunks are delivered sequentially using `sendMessage`.
  4. The inline keyboard (`◀ Back`, `📦 Return to Product`, `🏠 Home`) is attached **strictly to the final chunk**, ensuring it appears below all text.
- If an intermediate chunk delivery fails, subsequent chunks are not sent and the attempt failure policy is triggered.

---

## 7. Supported vs. Deferred Runtime Actions

### 7.1 Supported Runtime Features (Phase 06-A)
- **/start command:** Strictly matched with `/^\/start(?:@\w+)?(?:\s+.*)?$/i`. Non-start messages trigger plain-text guidance (`"To browse our catalog, please send /start"`).
- **Language Selection:** Persists customer preference to `customer.selectedLanguageId` and immediately renders catalog in chosen language.
- **Root Catalog Pagination:** Paginated when root categories exceed `TELEGRAM_MENU_PAGE_SIZE = 10` with stable tie-breaking (`ORDER BY sort_order ASC, id ASC`).
- **Catalog Browsing:** Category hierarchy traversal, nested subcategories, product lists.
- **Product Card:** Localized name, description, and exact decimal price (`price` + `bot_setting.currency`) without floating-point conversion.
- **`OPEN_SUBMENU`:** Configured localized `menu_text` (or fallback) and active child buttons in deterministic sibling order (`ORDER BY sort_order ASC, id ASC`).
- **`SHOW_DETAILS`:** Localized `details`, falling back to `description`, delivered via multi-chunk preservation.
- **Navigation Controls:** Context-aware `◀ Back`, `🏠 Home`, and `📦 Return to Product`.
- **Ancestry Safeguards:** Category and action hierarchies walk up to safeguard depth (64) and fail closed if cycles or inactive ancestors are detected.

### 7.2 Deferred Actions & Truthful Fallback
The following action types have full administrative configuration and database persistence in Rabet, but their customer-side runtime is deferred to upcoming phases:
- `START_INQUIRY` (Phase 07)
- `OPEN_SUPPORT` (Phase 07)
- `SEND_TEMPLATE_MESSAGE` (Deferred)
- `OPEN_URL` (Deferred)
- `NAVIGATE_CATALOG` (Deferred)

**Truthful Boundary Guarantee:**
When a deferred action button is tapped in Telegram:
- The bot displays: `"This action is not yet supported in this version."`
- Calls `answerCallbackQuery` to stop the Telegram loading spinner.
- Provides clear Back, Return to Product, and Home buttons.
- **Does not execute another action instead.**
- **Does not create an inquiry, customer conversation, or inbox item.**
- **Does not claim that a message was sent to the seller.**

---

## 8. Verification Results

All test suites executed and passed against real disposable PostgreSQL and clean environment:

| Suite / Command | Scope | Result |
| --- | --- | --- |
| `npm run lint` | ESLint across all source and test files | ✅ Pass (0 errors, 0 warnings) |
| `npm run typecheck` | Strict TypeScript compilation check | ✅ Pass (0 errors) |
| `npm test` | All unit tests across all application modules | ✅ Pass (500 passed) |
| `npm run test:telegram` | Webhook, retry ownership, privacy, tokens, chunking, and transport suites | ✅ Pass (66 passed) |
| `npm run test:db` | All real PostgreSQL database integration tests | ✅ Pass (217 passed) |
| `npm run db:check` | Drizzle schema check against migration chain | ✅ Pass (Everything's fine) |
| `env -u DATABASE_URL npm run build` | Next.js production build without database or credentials | ✅ Pass (Route `/api/telegram/webhook` registered) |

---

## 9. Owner-Approved Activation Runbook (What Requires Real Telegram)

**No live external activation was performed during this slice.**
Real bot tokens, webhook registrations, remote database migrations, and live Telegram messages were strictly avoided.

### 9.1 Mandatory Database & Store Requirements Before Live Webhook Setup
Before configuring Telegram webhook in production:
1. **Approved Initialized Production Database:**
   - Production requires its own approved, dedicated initialized production database containing all applied Drizzle migrations (`drizzle/0000_initial_schema.sql` and `drizzle/0001_tree_and_snapshot_integrity.sql`).
   - **CRITICAL SAFEGUARD:** Never point Production at `Rabet_dev`. Production and development databases must remain strictly isolated.
2. **Store Settings Singleton:**
   - `bot_setting` table row (`id = 1`) must exist with an approved `default_language_id`, `currency`, and `display_name`.
3. **Active Languages & Catalog Content:**
   - At least one active language (`language.is_enabled = true`).
   - At least one active root category (`category.parent_id IS NULL`, `is_active = true`) with translations.
   - Products and product action trees configured and marked active.

### 9.2 Webhook Registration Procedure
When the product owner approves live activation:
1. **Set Server-Only Environment Variables in Vercel / Production:**
   - `TELEGRAM_BOT_TOKEN`: The bot token issued by @BotFather.
   - `TELEGRAM_WEBHOOK_SECRET`: A generated high-entropy random string (e.g., `openssl rand -hex 32`).
2. **Register the Webhook with Telegram:**
   Execute with owner-held credentials:
   ```bash
   curl -F "url=https://<YOUR_DEPLOYED_DOMAIN>/api/telegram/webhook" \
        -F "secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>" \
        https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook
   ```
3. **Verify Webhook Status:**
   ```bash
   curl https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/getWebhookInfo
   ```
   Confirm `url` matches `https://<YOUR_DEPLOYED_DOMAIN>/api/telegram/webhook`, `has_custom_certificate` is false, and `pending_update_count` is 0.
4. **Live Verification Steps in Telegram:**
   - Open bot chat in Telegram client.
   - Send `/start`.
   - Select language (if multiple enabled).
   - Tap category buttons -> navigate nested category.
   - Tap product card -> verify displayed price matches catalog.
   - Tap submenu -> tap `SHOW_DETAILS` -> verify details and navigation back to product and Home.
