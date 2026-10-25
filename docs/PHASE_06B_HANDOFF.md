# Phase 06-B Handoff: Complete Non-Conversation Product Action Runtime

## 1. Overview and Scope

Phase 06-B completes the customer-facing runtime for all three non-conversation terminal product action types in Telegram:
1. `SEND_TEMPLATE_MESSAGE`: Sends a configured localized message to the customer's private chat with safe single-pass placeholder interpolation, sequential chunk preservation for long messages, and navigation controls on the final chunk.
2. `OPEN_URL`: Revalidates action and source hierarchy on tap, validates stored URL using WHATWG HTTPS validation, and renders a localized intermediary view with a dedicated "Open link" URL button and Back/Home navigation.
3. `NAVIGATE_CATALOG`: Revalidates hierarchy, validates single target existence and complete ancestry visibility, and seamlessly transitions to the destination category first page or product card without duplicate callback query acknowledgement or automatic recursive action execution.

This slice preserves the entire Phase 06-A foundation:
- App Router webhook route (`POST /api/telegram/webhook`).
- Timing-safe constant-time secret token validation.
- Database-backed atomic claim ownership, stale lease recovery, and attempt fencing on `telegram_update`.
- Structured allowlisted diagnostics without leaking credentials, SQL, or customer text.
- Expired callback acknowledgement recovery and execution budget tracking.
- Zero mutations or configuration repair writes on catalog reads and navigation.

**Scope Boundary Notice:**
- `START_INQUIRY` and `OPEN_SUPPORT` remain deliberately deferred in this slice, displaying truthful user-facing feedback (`"This action is not yet supported in this version."`) and creating zero inquiry, conversation, or message records.
- Inquiries and customer-seller conversations belong to **Phase 07**.
- Seller operations and inbox replies belong to **Phase 09**.
- Live webhook activation, external Telegram acceptance, and release hardening belong to **Phase 10**.

---

## 2. Customer Action Behaviors & Interaction Models

### 2.1 `SEND_TEMPLATE_MESSAGE`
- **Trigger:** Customer taps an action button configured with `SEND_TEMPLATE_MESSAGE`.
- **Bot Delivery:** Delivers a bot response directly to the customer's private chat using `sendMessage` (via `sendOrThrow`), leaving the original action menu message intact. It is strictly a customer-facing bot response, not an inquiry or seller notification.
- **Language & Body Resolution:**
  - Identifies customer's effective language (or store default fallback).
  - Queries `product_action_translation` for `preferred` and `fallback` (store default language) rows.
  - Resolves `template_body`: uses nonblank preferred-language body if present; otherwise falls back to nonblank default-language body.
  - A translated label alone does not suppress body fallback. If the preferred language row exists with an empty or whitespace body, the default language body is used.
  - If neither body is usable (missing or whitespace in both languages), or if stored syntax is malformed, a localized safe unavailable response (`ui.optionUnavailable`) is delivered with Back/Home navigation.
- **Placeholder Context & Exact Formatting:**
  - `{{store_name}}`: Current store display name (`settings.displayName`).
  - `{{product_name}}`: Localized source product name using standard translation fallback (`preferred?.name ?? fallback?.name ?? productRow.slug`).
  - `{{customer_name}}`: Customer's first and last names joined cleanly (`[first, last].filter(Boolean).join(" ")`). If unavailable, substitutes a localized generic fallback (`"Customer"` in LTR / `"عميلنا العزيز"` in RTL). Admin sample names (e.g. "Sarah Ahmed") are never used.
  - `{{price}}`: Exact decimal price string from database followed by store currency (`${productRow.price} ${settings.currency}`). Never parsed as floating point or converted.
- **Single-Pass Non-Recursive Interpolation:**
  - Evaluates placeholders in a single pass using `interpolateActionTemplate`.
  - Placeholder-like tokens (e.g. `{{price}}`) embedded inside substituted customer or product text are treated as literal text and never re-scanned or expanded.
- **Sequential Chunking & Navigation Placement:**
  - Messages exceeding Telegram's 4096 code-unit limit are split cleanly via `splitMessageText` without dropping any characters.
  - Intermediate chunks carry no keyboard.
  - Context-aware navigation (`◀ Back`, `📦 Return to Product` if in submenu, `🏠 Home`) is attached strictly to the final chunk.

### 2.2 `OPEN_URL`
- **Trigger:** Customer taps an action button configured with `OPEN_URL`.
- **Interaction Contract:**
  - Does **not** render a direct external link on the source product card or submenu.
  - Revalidates action and source hierarchy (action, action ancestors, source product, category ancestry) from the database at tap time.
  - Reads stored `product_action.url` and validates it with `validateHttpsUrl`.
  - On success, renders a small localized view via `editMessageText` displaying the action's localized label and an inline keyboard containing:
    1. Dedicated URL button: `{ text: ui.openLink, url: validatedUrl }` (carries `url` only, no `callback_data`).
    2. Back button: `{ text: ui.back, callback_data: backTarget }`.
    3. Return to Product button (if inside submenu).
    4. Home button: `{ text: ui.home, callback_data: tokens.home() }`.
  - The URL button is then tapped and handled by the customer's Telegram client.
- **Server Safety & Revocation Boundary:**
  - Our server **never** fetches, HEADs, scrapes, previews, or follows external URLs.
  - No customer information, tokens, or session secrets are appended to URLs.
  - **Honest Revocation Boundary:** Once a URL message or button is rendered on a customer's Telegram client, Telegram retains that markup locally. Our server cannot revoke or re-validate the URL at the moment the client actually opens it in a browser. The intermediate tap view exists specifically to ensure that link availability and authorization are verified at tap time before presenting the external link.
  - If stored URL is missing, invalid, non-HTTPS, or contains credentials/whitespace, safe unavailable feedback (`ui.optionUnavailable`) is shown without a URL button.

### 2.3 `NAVIGATE_CATALOG`
- **Trigger:** Customer taps an action button configured with `NAVIGATE_CATALOG`.
- **Target Resolution & Visibility Safeguards:**
  - Stored target columns: `product_action.navigate_category_id` OR `product_action.navigate_product_id`.
  - Enforces exactly one target: configurations with zero targets or both targets fail closed with safe unavailable feedback (`ui.optionUnavailable`) and navigation back to source context.
  - Validates target UUID grammar upfront.
  - **Category Target:** Checks target category existence, `is_active`, `deleted_at IS NULL`, and walks up category ancestry to safeguard depth (64) ensuring all ancestors are active and not deleted.
  - **Product Target:** Checks target product existence, `is_active`, `deleted_at IS NULL`, and checks that its category hierarchy is completely active.
  - If target or any ancestor is inactive, soft-deleted, or cyclical, the request fails closed with safe localized feedback (`ui.categoryUnavailable` or `ui.productUnavailable`) and source context navigation. Target names, descriptions, or prices are **never exposed** if hidden or inactive.
- **Destination Rendering & Single-Ack Guarantee:**
  - For a valid category target, renders that category's standard first page via extracted `renderCategory` helper. Destination Back points to target category's parent (or Home).
  - For a valid product target, renders the destination product card via `renderProductCard`. Destination Back points to target product's category.
  - Invokes renderers directly without recursive `handleCallbackQuery` calls, guaranteeing callback query acknowledgement is called **exactly once** per customer interaction.
  - Does **not** automatically execute destination actions. The destination view is rendered with buttons ready for subsequent customer taps.

---

## 3. Delivery Failure, Retry Ownership & Ambiguity Boundary

1. **Failure and Retry Policy:**
   - Any outbound transport failure during `sendMessage` or `editMessageText` throws `TelegramTransportError`.
   - The webhook catches the transport error, records an allowlisted structured diagnostic (e.g. `category=api_error` or `category=timeout`) in `telegram_update.processing_error`, and exits with an error status (e.g. HTTP 500 or 503).
   - `processed_at` remains `NULL`. The attempt lease expires after 30 seconds, allowing Telegram's redelivery to reclaim the attempt and retry.
2. **External Delivery Ambiguity:**
   - External HTTP transport delivery to Telegram and local database completion fencing are distinct operations across network boundaries.
   - If a crash occurs after Telegram receives a message chunk but before the worker marks the update processed, redelivery might duplicate the message send. Single-worker lease ownership and atomic completion fencing strictly minimize this window.
3. **Button Representation Integrity:**
   - Enforced in `validatePayloadLimits` across fake and live transports:
     - No button may combine `url` and `callback_data`.
     - Every button must specify either `url` or `callback_data`.
     - `callback_data` cannot exceed 64 UTF-8 bytes.

---

## 4. Verification Results

All unit and PostgreSQL integration suites executed cleanly against disposable local test clusters:

| Suite / Command | Scope | Result |
| --- | --- | --- |
| `npm run lint` | ESLint across all codebase and test files | ✅ Pass (0 errors, 0 warnings) |
| `npm run typecheck` | Strict TypeScript compilation (`tsc --noEmit`) | ✅ Pass (0 errors) |
| `npm test` | All unit tests across all application modules | ✅ Pass (32 suites passed, 15 skipped; 503 passed, 232 skipped) |
| `npm run test:telegram` | Webhook, retry ownership, privacy, tokens, chunking, transport, and Phase 06-B runtime suites | ✅ Pass (3 suites passed; 90 passed, 0 failed) |
| `npm run test:db` | All real PostgreSQL database integration suites | ✅ Pass (16 suites passed; 238 passed, 0 failed) |
| `npm run db:check` | Drizzle schema check against migration chain | ✅ Pass ("Everything's fine 🐶🔥") |
| `env -u DATABASE_URL npm run build` | Next.js production build without database or credentials | ✅ Pass (Compiled and generated routes cleanly) |

---

## 5. Remaining Work (Roadmap)

- **Phase 07: Customer Inquiries & Messaging:**
  - Customer taps `START_INQUIRY` or `OPEN_SUPPORT`.
  - Creates customer conversation and inquiry record.
  - Captures message context and notifies seller.
- **Phase 09: Seller Operations & Inbox:**
  - Seller dashboard for viewing inquiries and conversations.
  - Sending replies back to customers in Telegram.
- **Phase 10: Testing, Security & Release Hardening:**
  - Durable rate limiting on public endpoints.
  - Interactive browser and multi-device acceptance.
  - Production database migration and live webhook registration runbook.
