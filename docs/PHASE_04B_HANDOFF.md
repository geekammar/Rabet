# Phase 04-B Handoff — Global Bot Content Editor

## 1. Git State and Commits

- **Repository**: [geekammar/Rabet](https://github.com/geekammar/Rabet)
- **Base Commit**: `4d1c2bb939b4017b8090b2605ba52c1cca97c2f5` (fresh `origin/main` after PR #10 merge)
- **Feature Branch**: `feat/phase-04b-bot-content`
- **Target Pull Request**: Targeted against `main`
- **Package Manager**: `npm` with committed `package-lock.json`

---

## 2. Scope & Implementation Summary

### What Was Built

1. **Approved Template Registry (`src/lib/bot-content/registry.ts`)**:
   - Fixed 7 approved canonical template keys (no arbitrary creation, renaming, or deletion):
     - `bot_welcome`: Main welcome greeting (Group: Welcome).
     - `support_welcome`: Support introduction message (Group: Support).
     - `support_received`: Support inquiry acknowledgment (Group: Support).
     - `inquiry_received`: Product inquiry acknowledgment (Group: Inquiries).
     - `conversation_resolved`: Conversation resolution notice (Group: Support).
     - `option_unavailable`: Unavailable action notice (Group: Navigation).
     - `empty_menu`: Empty catalog/menu notice (Group: Navigation).
   - Immutable metadata per template: canonical key, human-readable title, operational purpose, group, allowed placeholders, and pre-written suggested English and Arabic text.

2. **Pure Validation & Non-Recursive Interpolation (`src/lib/bot-content/placeholders.ts`)**:
   - `validateTemplateBody(body, templateKey, sampleContext)`:
     - Enforces non-blank content (trimmed length $\ge 1$).
     - Enforces maximum character length ($\le 4096$ chars, matching Telegram message limits).
     - Validates placeholder syntax: checks for unclosed `{{`, stray closing `}}`, triple braces `{{{` / `}}}`, or malformed patterns.
     - Strict allowlist enforcement:
       - `{{store_name}}`: Allowed in all 7 templates.
       - `{{product_name}}`: Allowed **only** in `inquiry_received`; rejected in all other 6 templates.
       - Any unrecognized placeholder identifier (e.g. `{{user_name}}`, `{{foo}}`) is rejected with a clear descriptive error.
     - Enforces preview rendered length $\le 4096$ characters when sample context is interpolated.
   - `interpolateTemplate(template, context)`:
     - Single-pass replacement using a strict regular expression `/{{\s*([a-zA-Z0-9_]+)\s*}}/g`.
     - Non-recursive: Sample values containing placeholder syntax (e.g. `Acme {{store_name}} Inc`) are inert and never re-evaluated.
     - Unmatched placeholders remain intact without throwing.

3. **Secure Server Action (`src/app/actions/bot-content.ts`)**:
   - `saveBotContentTranslation(input)`:
     - Calls `requireAdmin()` **before any database access**; unauthorized requests perform zero database operations.
     - Validates input format (rejects non-object payloads, missing fields, non-string types) and validates against the 7-key registry.
     - Validates body and placeholders using pure validator before any write.
     - Verifies language is supported and registered in the database (`readLanguage`).
     - Idempotently creates template record (`createTemplate`) if absent, then saves translation (`saveTranslation`).
     - Honest error reporting: If translation save fails, reports failure; never claims success prematurely.
     - Preserves existing translations: Saving one language does not overwrite or mutate other languages.
     - Preserves language enablement: Saving Arabic on a registered-but-disabled language row does not alter `is_enabled`.

4. **Bot Content Editor UI (`src/app/(dashboard)/bot-content/page.tsx` & components)**:
   - Replaced placeholder route with full dashboard editor.
   - Four availability states:
     - **State A**: Missing `DATABASE_URL` -> renders safe setup-required card.
     - **State B**: Unreachable database outage -> renders recoverable error card with credentials redacted.
     - **State C**: Unconfigured store settings -> renders guidance card linking to `/settings`.
     - **State D**: Configured store -> loads templates and renders editor.
   - **Zero writes on render**: Viewing the page with missing templates/translations performs zero database writes. Missing items are displayed honestly with "Missing" status badges and fallback indicators.
   - 7 cards grouped into 4 sections: Welcome, Support, Inquiries, Navigation.
   - Dual-level language switching:
     - Global editing language selector at the top (English or registered Arabic).
     - Per-card language tabs allowing independent editing.
     - Callout banner explaining Arabic editing when registered but disabled (explaining that saving text will not enable Arabic store-wide).
     - Guidance link to `/settings` if Arabic is not yet registered.
   - Mobile-first card controls:
     - Labeled sample context preview box with preserved line breaks and HTML escaping (XSS safe).
     - RTL text direction for Arabic textarea and preview container.
     - "Use suggested text" button modifying only local draft (zero database writes until explicit Save).
     - Live character count counter.
     - Quick-insert placeholder chips (`+ {{store_name}}`, `+ {{product_name}}`).
     - Unsaved changes indicator and Reset button.
     - Explicit Save button with clear loading state, success message, or error feedback.
     - User input preserved in textarea upon validation errors.
     - Strict $\ge 44$px touch targets across all interactive buttons, tabs, and chips.
     - 0 horizontal overflow at 360px viewport.

### What Was Excluded (Explicit Non-Goals)

- **No Telegram API calls or webhook delivery**: Editor and persistence only; no outbound Telegram messaging.
- **No Telegram Markdown/HTML parse modes**: Plain text message format only.
- **No arbitrary template management**: No custom template keys, no key renaming, no template deletion.
- **No bulk saving**: Explicit per-template, per-language save contract.
- **No rich-text editors, WYSIWYG, or drag-and-drop canvases**.
- **No catalog or product actions editing** (Phase 05).
- **No schema modifications, new migrations, or package upgrades**.

---

## 3. Template Registry & Placeholder Contract

| Template Key | Group | Title | Purpose | Allowed Placeholders |
|---|---|---|---|---|
| `bot_welcome` | Welcome | Main Welcome | Initial greeting when customer opens bot | `{{store_name}}` |
| `support_welcome` | Support | Support Welcome | Introduction when entering support channel | `{{store_name}}` |
| `support_received` | Support | Support Inquiry Acknowledged | Confirmation after submitting support request | `{{store_name}}` |
| `inquiry_received` | Inquiries | Product Inquiry Acknowledged | Confirmation after inquiring about a product | `{{store_name}}`, `{{product_name}}` |
| `conversation_resolved` | Support | Conversation Resolved | Notice when support conversation is closed | `{{store_name}}` |
| `option_unavailable` | Navigation | Action Unavailable | Notice when selected action/button is invalid | `{{store_name}}` |
| `empty_menu` | Navigation | Catalog Empty | Notice when a category or catalog is empty | `{{store_name}}` |

### Placeholder Validation Rules

- **Allowed syntax**: Exact double-brace format `{{<identifier>}}` (optional leading/trailing whitespace inside braces).
- **Syntax errors rejected**:
  - Unclosed braces: e.g. `Welcome {{store_name`
  - Stray closing braces: e.g. `Welcome store_name}}`
  - Triple braces: e.g. `{{{store_name}}}`
- **Allowlist rules**:
  - `{{store_name}}`: Allowed in all 7 templates.
  - `{{product_name}}`: Allowed strictly in `inquiry_received`.
  - Unknown identifiers: Rejected with descriptive error (`Unknown placeholder '{{user}}'`).
- **Safe preview guarantees**:
  - Line breaks are preserved via CSS `whitespace-pre-wrap`.
  - Preview renders via standard React text node escaping (malicious HTML/script strings remain inert plain text).
  - Single-pass non-recursive interpolation prevents placeholder expansion inside context values.

---

## 4. Save/Retry & Missing-Content Behavior

1. **Page Load Contract**:
   - Loading `/bot-content` does not write to `message_template` or `message_translation`.
   - Missing templates and translations display honest missing state indicators (`Missing (EN)` / `Missing (AR)`).
   - Suggested text is never treated as saved runtime content; fallback follows DATA_MODEL.md resolver chain: `requested language` -> `configured default language` -> `explicitly missing`.

2. **Explicit Save Contract**:
   - Saves are strictly per-template, per-language.
   - Validation occurs before any database operation.
   - If `message_template` row does not exist for the canonical key, `createTemplate` creates only that specific template row.
   - `saveTranslation` saves only the selected language translation.
   - Unrelated templates and languages are never seeded or touched.

3. **Safe Retries & Atomic State**:
   - If template metadata creation succeeds but translation write fails, the action reports failure honestly.
   - Retrying safely updates the existing template row without duplicating records.
   - Existing translations in other languages (e.g. English) are preserved when updating Arabic.
   - Arabic translations can be saved when Arabic is registered but disabled in store settings; saving does not enable the language in `language.is_enabled`.

---

## 5. Verification & Acceptance Results

### Unit & Integration Suites

Executed on VPS against clean code and disposable PostgreSQL:

- `npm run lint`: **0 errors, 0 warnings**.
- `npm run typecheck`: **Clean, exit code 0**.
- `DATABASE_URL= npm run build`: **Turbopack production build succeeded** (14/14 static and partial-prerendered routes, zero DB requirement at build time).
- `npm test`:
  - **19 test files passed**, 11 skipped (DB files reserved for `test:db`).
  - **313 passed tests**, 140 skipped, 0 failed.
  - Includes:
    - `src/lib/bot-content/__tests__/placeholders.test.ts`: 21 tests passed (registry integrity, validation rules, unknown placeholders, non-recursive guarantee, HTML inertness).
    - `src/app/actions/__tests__/bot-content.test.ts`: 11 tests passed (unauthorized 0 DB access, invalid input validation, failure reporting).
    - `tests/bot-content-page.test.ts`: 4 tests passed (States A, B, C, D availability states).
- `npm run test:db`:
  - **12 test files passed**, 0 failed.
  - **146 passed tests**, 0 failed against disposable PostgreSQL cluster with automatic teardown.
  - Includes:
    - `tests/db/bot-content.test.ts`: 6 tests passed (missing templates/translations, explicit single-template creation, idempotency/no duplicates, Arabic preservation of English, disabled Arabic persistence without enabling language, fallback chain preservation).
- `npm run db:check`: **Clean, schema in sync** ("Everything's fine 🐶🔥").

### Real Browser Acceptance Suite (`scripts/test-browser-acceptance.mjs`)

Executed against Next.js production server (`next start`), test-only authentication, disposable loopback PostgreSQL, and headless Chromium via Chrome DevTools Protocol (CDP):

| Flow | Description | Result | Details |
|---|---|---|---|
| Flow 1 | Initial empty state | **PASSED** | Navigated to `/bot-content`; 7 cards rendered with "Missing" badges; verified 0 templates and 0 translations created in DB on page load. |
| Flow 2 | Apply suggested text | **PASSED** | Clicked "Use suggested text" on `bot_welcome`; local draft updated, preview updated, "Unsaved changes" badge appeared; verified 0 database writes occurred. |
| Flow 3 | Explicit Save English | **PASSED** | Clicked "Save English Message"; reloaded page via CDP; verified text persisted in UI; verified DB contains exactly 1 template and 1 translation. |
| Flow 4 | Arabic editing & RTL | **PASSED** | Switched to Arabic tab; verified `dir="rtl"` on textarea and preview container; entered Arabic text and saved; verified DB contains both English and Arabic translations, English was preserved, and Arabic remained disabled (`is_enabled: false`). |
| Flow 5 | Invalid placeholder & draft preservation | **PASSED** | Entered unknown placeholder `{{unknown_placeholder}}` and clicked Save; verified validation error appeared; verified draft remained in textarea; verified DB retained previous valid text. |
| Flow 6 | Mobile 360px viewport & touch targets | **PASSED** | Emulated 360x740 mobile viewport; verified `scrollWidth === 360` (0 horizontal overflow); verified all interactive buttons, tabs, and chips have touch targets $\ge 44$px. |

**All 6 browser acceptance flows PASSED with exit code 0.**

---

## 6. Untested Items & Non-Goals

1. **Physical Mobile Device Testing**: Viewport emulation was validated at 360px in headless Chromium; physical Android/iOS touch hardware testing remains to be verified by product owner on Vercel preview.
2. **Telegram Bot Dispatch / Delivery**: Runtime Telegram bot consumption is reserved for Phase 06 and Phase 07.
3. **No Migration / Schema Changes**: No database migrations were added or modified in Phase 04-B.
