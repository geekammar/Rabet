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
│   ├── types.ts                       # Telegram Bot API updates, keyboards, and transport contracts
│   ├── tokens.ts                      # Strict <= 64-byte UTF-8 callback token encoder/parser
│   ├── transport.ts                   # Injected transport interface, fetch client, fake test transport
│   ├── catalog-journey.ts             # Navigation state-machine, visibility validation, localization
│   └── webhook.ts                     # Request authentication (timingSafeEqual), dedup, dispatch
├── lib/data/
│   ├── customer.ts                    # Minimal customer upsert and language preference persistence
│   └── telegram.ts                    # telegram_update deduplication log & retry status tracking
```

### 2.1 Webhook Authentication and Safety Boundary
- **Route:** `POST /api/telegram/webhook`.
- **Runtime:** Node.js runtime (App Router).
- **Session Exemption:** Configured in `src/proxy.ts` so the webhook is reachable without an admin session. Admin routes remain strictly guarded.
- **Request Authentication:** Incoming requests must present the secret token header `X-Telegram-Bot-Api-Secret-Token`. Validated using constant-time comparison (`crypto.timingSafeEqual`).
- **Fail-Closed Guarantee:** Missing configuration (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`) or invalid/missing secret tokens immediately fail closed (HTTP 503 / 401) with sanitized JSON responses and perform zero database writes and zero outbound HTTP calls.
- **Build Isolation:** The build succeed without a database or Telegram credentials (`env -u DATABASE_URL npm run build`). No database connections or Telegram endpoints are queried at module evaluation time.
- **Secret & Privacy Protection:** Bot tokens, request URLs with tokens, secret headers, database credentials, and raw customer message bodies are never logged or exposed in errors.

---

## 3. Callback Token Contract (`src/lib/telegram/tokens.ts`)

Telegram enforces a strict limit of **1–64 UTF-8 bytes** on `callback_data`. Rabet validates every callback data string against this byte length limit (`Buffer.byteLength(token, "utf8") <= 64`) before rendering keyboards.

All tokens are self-scoping and stateless:
| Token Pattern | Size (bytes) | Meaning |
| --- | --- | --- |
| `home` | 4 | Main catalog root (categories with `parent_id IS NULL`). |
| `lang:<code>` | 7 | Customer language selection (e.g., `lang:en`, `lang:ar`). |
| `c:<uuid>` | 38 | Open category menu (page 1). |
| `c:<uuid>:<n>` | 40–42 | Open category menu page `n`. |
| `p:<uuid>` | 38 | Open product card with displayed price and root buttons. |
| `a:<uuid>` | 38 | Execute product action (`OPEN_SUBMENU`, `SHOW_DETAILS`, etc.). |
| `m:<uuid>` | 38 | Open action submenu page 1. |
| `m:<uuid>:<n>` | 40–42 | Open action submenu page `n`. |
| `b:<uuid>` | 38 | Context-aware Back navigation from action to parent submenu or product card. |

---

## 4. Supported vs. Deferred Runtime Actions

### 4.1 Supported Runtime Features (Phase 06-A)
- **/start command:** Upserts minimal customer record (`telegramId`, names, username, language hint). Evaluates `bot_setting.askForLanguage` and enabled languages. Offers language choice keyboard only when choice is required; otherwise renders welcome message and root catalog.
- **Language Selection:** Persists customer preference to `customer.selectedLanguageId` and immediately renders catalog in chosen language.
- **Catalog Browsing:** Category hierarchy traversal, nested subcategories, product lists.
- **Product Card:** Displays localized name, description, and exact decimal price (`price` + `bot_setting.currency`) without floating-point conversion.
- **`OPEN_SUBMENU`:** Renders configured localized `menu_text` (or fallback) and active child buttons in saved sibling order.
- **`SHOW_DETAILS`:** Displays localized `details`, falling back to `description`, then generic safe message.
- **Navigation Controls:** Context-aware `◀ Back`, `🏠 Home`, and `📦 Return to Product`.
- **Deterministic Pagination:** Bounded page sizes (`TELEGRAM_MENU_PAGE_SIZE = 10`) with Next/Prev page controls.

### 4.2 Deferred Actions & Truthful Fallback
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

## 5. Authoritative Visibility & Stale Keyboard Protection

Telegram inline buttons remain in chat history indefinitely. To prevent stale buttons from bypassing current administrative state, every button tap authoritatively re-validates server-side:
1. **Target Existence:** Record must exist in PostgreSQL.
2. **Soft Deletion Check:** Record must have `deleted_at IS NULL`.
3. **Activation State:** Record must have `is_active = true`.
4. **Ancestor Chain Validation:** Every ancestor category and ancestor action up to the root must have `is_active = true` and `deleted_at IS NULL`.
5. **Submenu-Only Hierarchy:** Ancestor actions must be of type `OPEN_SUBMENU`.

If any validation fails (e.g., an admin deactivated a parent category or product after the customer received the keyboard), the bot answers with a localized unavailable notice (`"This category is no longer available."`, `"This product is no longer available."`, or `"This option is no longer available."`) and an offer to return Home or to the product card.

---

## 6. Deduplication, Idempotency, and Delivery Failure Guarantees

### 6.1 Database Idempotency
- Uses the existing `telegram_update` table.
- Each incoming update initiates an insert on `update_id` (`ON CONFLICT DO NOTHING`).
- **Sequential Redelivery:** If `processed_at` is non-null, the update is recognized as already handled and returns HTTP 200 `{ ok: true, status: "already_processed" }` without re-executing writes or outbound Telegram calls.
- **Concurrent Redelivery:** Parallel requests for the same `update_id` encounter unique constraint conflict; exactly one worker acquires the insert lock and processes the update.
- **Customer Upsert:** Customer records are upserted on `telegram_id` using `ON CONFLICT DO UPDATE`, preserving existing language choices and preventing duplicates.

### 6.2 Transport Failure and Retry Path
- External Telegram HTTP API calls cannot be made atomic inside a database transaction.
- When an outbound send or edit fails (e.g., Telegram timeout or HTTP 5xx):
  - `telegram_update.processing_error` records the sanitized error message.
  - `telegram_update.processed_at` **remains null**.
  - The webhook handler returns HTTP 500 so Telegram will retry delivery.
- On subsequent redelivery from Telegram, the handler detects that `processed_at` is null and retries the outbound call. Upon success, `processed_at` is stamped and `processing_error` is cleared.
- **Honest Delivery Boundary:** Exactly-once external delivery cannot be mathematically guaranteed across arbitrary process crashes occurring between Telegram send completion and database commit. In this slice, bounded idempotency and retry tracking prevent message duplication and dropped updates without heavyweight external queue infrastructure.

---

## 7. Verification Results

All suites executed and passed on real PostgreSQL and clean environment:

| Suite / Command | Scope | Result |
| --- | --- | --- |
| `npm run lint` | ESLint across all source files | ✅ Pass (0 errors) |
| `npm run typecheck` | Strict TypeScript check | ✅ Pass (0 errors) |
| `npm test` | Unit tests (`tokens`, `transport`, `bot-content`, etc.) | ✅ Pass (478 passed) |
| `npm run test:telegram` | Webhook, journey, tokens, and transport suites | ✅ Pass (20 passed) |
| `npm run test:db` | All real PostgreSQL database integration tests | ✅ Pass (191 passed) |
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
