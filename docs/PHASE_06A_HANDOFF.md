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
│   ├── types.ts                       # Telegram Bot API updates, error classification, and transport contracts
│   ├── tokens.ts                      # Strict <= 64-byte UTF-8 callback token encoder/parser with grammar validation
│   ├── transport.ts                   # Injected transport interface, fetch client with timeouts & sanitization, fake test transport
│   ├── catalog-journey.ts             # Navigation state-machine, visibility validation, localization, text bounding
│   └── webhook.ts                     # Request authentication (timingSafeEqual), input validation, atomic dedup/claim, dispatch
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
- **Secret & Privacy Protection:** Bot tokens, database connection URLs, secret headers, customer message bodies, and raw exception objects are never returned in public HTTP responses or logged. Public responses use fixed strings (`"Internal server error"`, `"Bad request"`, `"Unauthorized"`, `"Telegram webhook is not configured."`).

---

## 3. Atomic Retry Ownership & Database Recovery Policy

The webhook deduplication and retry mechanism is database-backed and compatible with the production Neon HTTP driver (where cross-instance advisory locks or interactive multi-query transactions are not available):

### 3.1 Attempt Claiming Protocol (`claimTelegramUpdate`)
1. **Initial Attempt:** Uses `INSERT INTO telegram_update (update_id, update_type, payload) VALUES (...) ON CONFLICT DO NOTHING RETURNING ...`.
   - If a row is inserted, the attempt acquires ownership (`status: "claimed"`).
2. **Concurrent Initial Race:** If another worker concurrently receives the same `update_id`, only one row is inserted. The losing worker inspects the record: if `processed_at IS NULL` and `processing_error IS NULL` and the lease is active, it returns `status: "in_flight"`.
3. **Atomic Retry / Recovery:** When an update failed previously (`processing_error IS NOT NULL`) or an in-flight attempt was abandoned past the lease window, a worker claims ownership via a single conditional atomic update:
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
   PostgreSQL row-level write serialization guarantees that across concurrent retry deliveries, **exactly one** worker succeeds and acquires ownership (`status: "claimed"`). The runner receives `status: "in_flight"` and avoids duplicate work.
4. **Attempt Identity Guard:** Each claim stamps a unique `attemptId` (UUID) into `payload->>'attemptId'`.
   - `markTelegramUpdateProcessed(db, { updateId, attemptId })` updates `processed_at` only `WHERE payload->>'attemptId' = :attemptId`.
   - `markTelegramUpdateFailed(db, { updateId, attemptId, errorMessage })` updates `processing_error` only `WHERE payload->>'attemptId' = :attemptId`.
   - **Stale Attempt Protection:** A stale attempt that was superseded by a newer retry attempt cannot mark the record processed or overwrite newer attempt diagnostics.
5. **Abandoned In-Flight Recovery:** `IN_FLIGHT_LEASE_MS = 30_000` (30 seconds). If a serverless instance crashes mid-execution without setting `processing_error`, subsequent redeliveries after 30 seconds atomically reclaim the update. Permanently abandoned in-flight records are not treated as successful processing.
6. **Delivery Ambiguity Boundary:** External HTTP delivery to Telegram cannot be transactional with a database write. If a process dies immediately after `sendMessage` succeeds but before `markTelegramUpdateProcessed` commits, Telegram will not retry (since it received 200, or will retry if connection closed). A database cannot guarantee exactly-once physical delivery across arbitrary external crash windows; our architecture guarantees single-owner attempt execution and idempotency without heavyweight queue infrastructure.

---

## 4. Callback Token Contract (`src/lib/telegram/tokens.ts`)

Telegram enforces a strict limit of **1–64 UTF-8 bytes** on `callback_data`. Rabet strictly validates input and output against token grammar:

| Token Pattern | Size (bytes) | Grammar & Range | Meaning |
| --- | --- | --- | --- |
| `home` | 4 | Exact match | Main catalog root (page 1). |
| `c:root` | 6 | Exact match | Root categories list (page 1). |
| `c:root:<n>` | 8–12 | `<n>` is positive integer `[1..99999]` | Root categories list page `n`. |
| `lang:<code>` | 7 | `<code>` matches `^[a-z]{2,5}(-[a-zA-Z0-9]+)?$` | Customer language selection (e.g., `lang:en`, `lang:ar`). |
| `c:<uuid>` | 38 | `<uuid>` matches 8-4-4-4-12 hex UUID | Open category menu (page 1). |
| `c:<uuid>:<n>` | 40–44 | `<uuid>` + positive integer `[1..99999]` | Open category menu page `n`. |
| `p:<uuid>` | 38 | `<uuid>` matches 8-4-4-4-12 hex UUID | Open product card with displayed price. |
| `a:<uuid>` | 38 | `<uuid>` matches 8-4-4-4-12 hex UUID | Execute product action (`OPEN_SUBMENU`, `SHOW_DETAILS`, etc.). |
| `m:<uuid>` | 38 | `<uuid>` matches 8-4-4-4-12 hex UUID | Open action submenu page 1. |
| `m:<uuid>:<n>` | 40–44 | `<uuid>` + positive integer `[1..99999]` | Open action submenu page `n`. |
| `b:<uuid>` | 38 | `<uuid>` matches 8-4-4-4-12 hex UUID | Back navigation from action to parent submenu or product card. |

**Grammar Validation:**
- Values such as `c:not-a-uuid`, `c:<uuid>:2junk`, negative/fractional pages (`c:<uuid>:-1`), or overlength UTF-8 strings (>64 bytes) are strictly parsed as `{ type: "unknown", raw: ... }` rather than silently accepted via `parseInt` defaults.

---

## 5. Delivery Results, Timeouts, and Error Classification

### 5.1 Transport Timeout & Sanitization (`src/lib/telegram/transport.ts`)
- All outbound Telegram requests use `AbortSignal.timeout(10_000)` (`DEFAULT_REQUEST_TIMEOUT_MS = 10_000`).
- Errors are classified into structured kinds:
  - `"not_modified"`: Telegram 400 when edited message content matches identically; treated as successful no-op.
  - `"not_editable"`: Telegram 400 when message cannot be edited or was deleted; safely triggers fallback to `sendMessage`.
  - `"rate_limited"`: Telegram 429; captures `parameters.retry_after`.
  - `"timeout"`: AbortError or TimeoutError.
  - `"network_error"`: Connection drops or DNS failures.
  - `"api_error"`: Other 4xx/5xx responses or non-JSON payloads (e.g. 502 Bad Gateway HTML).
- **Selective Edit Fallback:** `editOrThrow` falls back to `sendMessage` **only** when `errorKind === "not_editable"`. Timeouts, rate-limits, and API errors throw immediately to avoid duplicate messages or traffic spikes.

### 5.2 Payload Limits & Safe Text Bounding
- Telegram restricts message text to **4096 characters** and callback data to **64 bytes**.
- `boundMessageText(text, maxLen = 4096)`: Safely bounds text without splitting UTF-16 surrogate pairs (e.g. multibyte emojis).
- Fake transport (`createFakeTelegramTransport`) enforces these limits in tests to mirror official Telegram Bot API validation.

---

## 6. Supported vs. Deferred Runtime Actions

### 6.1 Supported Runtime Features (Phase 06-A)
- **/start command:** Strictly matched with `/^\/start(?:@\w+)?(?:\s+.*)?$/i`. Non-start messages trigger plain-text guidance (`"To browse our catalog, please send /start"`). If sending guidance fails, HTTP 500 is returned.
- **Language Selection:** Persists customer preference to `customer.selectedLanguageId` and immediately renders catalog in chosen language.
- **Root Catalog Pagination:** Paginated when root categories exceed `TELEGRAM_MENU_PAGE_SIZE = 10` with stable tie-breaking (`ORDER BY sort_order ASC, id ASC`).
- **Catalog Browsing:** Category hierarchy traversal, nested subcategories, product lists.
- **Product Card:** Displays localized name, description, and exact decimal price (`price` + `bot_setting.currency`) without floating-point conversion.
- **`OPEN_SUBMENU`:** Renders configured localized `menu_text` (or fallback) and active child buttons in deterministic sibling order (`ORDER BY sort_order ASC, id ASC`).
- **`SHOW_DETAILS`:** Displays localized `details`, falling back to `description`, then generic safe message.
- **Navigation Controls:** Context-aware `◀ Back`, `🏠 Home`, and `📦 Return to Product`.
- **Ancestry Safeguards:** Validates category and action hierarchies. If loop reaches safeguard depth (64) while ancestors remain unresolved, it **fails closed** (`valid: false`).

### 6.2 Deferred Actions & Truthful Fallback
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

## 7. Verification Results

All test suites executed and passed against real disposable PostgreSQL and clean environment:

| Suite / Command | Scope | Result |
| --- | --- | --- |
| `npm run lint` | ESLint across all source and test files | ✅ Pass (0 errors, 0 warnings) |
| `npm run typecheck` | Strict TypeScript compilation check | ✅ Pass (0 errors) |
| `npm test` | All unit tests across all application modules | ✅ Pass (489 passed) |
| `npm run test:telegram` | Webhook, retry ownership, privacy, tokens, and transport suites | ✅ Pass (39 passed) |
| `npm run test:db` | All real PostgreSQL database integration tests | ✅ Pass (201 passed) |
| `npm run db:check` | Drizzle schema check against migration chain | ✅ Pass (Everything's fine) |
| `env -u DATABASE_URL npm run build` | Next.js production build without database or credentials | ✅ Pass (Route `/api/telegram/webhook` registered) |

---

## 8. Owner-Approved Activation Runbook (What Requires Real Telegram)

**No live external activation was performed during this slice.**
Real bot tokens, webhook registrations, remote database migrations, and live Telegram messages were strictly avoided.

When the product owner approves live activation:
1. **Set Environment Variables in Vercel / Production:**
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
