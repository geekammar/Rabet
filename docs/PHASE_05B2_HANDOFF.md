# Phase 05-B2 Handoff: Complete Remaining Four Product Action Types

## 1. Overview and Intent

Phase 05-B2 completes administrative configuration and persistence for all seven approved product action types in Rabet (رابط):
1. `OPEN_SUBMENU` (Phase 05-B1)
2. `SHOW_DETAILS` (Phase 05-B1)
3. `START_INQUIRY` (Phase 05-B1)
4. `SEND_TEMPLATE_MESSAGE` (Phase 05-B2)
5. `OPEN_URL` (Phase 05-B2)
6. `OPEN_SUPPORT` (Phase 05-B2)
7. `NAVIGATE_CATALOG` (Phase 05-B2)

The existing recursive action editor (`ProductActionEditor`) is extended directly. No second editor or generic workflow engine was created.

This slice is strictly focused on configuration and persistence of actions. It does **not** execute actions in Telegram, register Telegram webhooks, create inquiries or customer conversations, process payments, or provide checkout workflows.

No database migrations or schema alterations were performed. Existing columns on `product_action` (`url`, `navigate_category_id`, `navigate_product_id`, `action_config`) and `product_action_translation` (`template_body`) are reused directly.

---

## 2. Type-Specific Contracts & Architecture Decisions

### 2.1. `SEND_TEMPLATE_MESSAGE`
- **Storage:** Persisted per-action in `product_action_translation.template_body`. It is **not** linked via foreign key to the seven global bot message templates.
- **Fields:**
  - Localized button label (`product_action_translation.label`, 1–64 code points).
  - Localized plain-text message body (`product_action_translation.template_body`, 1–4096 code points).
- **Placeholder Engine (`src/lib/product-actions/templates.ts`):**
  - Strict `{{identifier}}` double-brace syntax.
  - Allowlist strictly limited to action message context: `{{store_name}}`, `{{product_name}}`, `{{customer_name}}`, `{{price}}`.
  - Single-pass non-recursive interpolation. Evaluation, HTML execution, and Telegram markdown parse modes are prohibited.
  - Malformed placeholders (e.g. `{{unknown}}`, unclosed braces) are rejected during validation.
  - Global bot message template keys and permissions remain unchanged.
- **Preview & Drafts:**
  - Administrative preview renders with clearly identified sample context (`Customer Name`, product name, store display name, formatted price).
  - Draft inputs are preserved across language tabs.
  - Default-language body is authoritatively required when creating, activating, or converting to this type. Evaluated dynamically against store default language.
  - Safe deactivation of invalid actions is allowed without throwing.
  - Omitted same-type body preserves stored value; optional language body clearing is permitted and falls back to default body.
  - Structured safe errors returned at server action boundary.
  - Placeholder helper chips provide >=44x44px touch targets and coordinate with pending/busy state.

### 2.2. `OPEN_URL`
- **Storage:** Persisted in `product_action.url`.
- **Validation (`src/lib/product-actions/validation.ts`):**
  - Validated server-side using the WHATWG URL parser (`validateHttpsUrl`).
  - Requires absolute URL with protocol `https:`.
  - Requires a valid non-empty hostname.
  - Rejects embedded credentials (username or password).
  - Rejects `javascript:`, `data:`, `file:`, `http:`, and malformed URLs.
  - Destination URLs are **never** fetched server-side.
- **Scope Boundary:** Informational external navigation only; payments and checkout links are strictly outside scope.

### 2.3. `OPEN_SUPPORT`
- **Storage:** Persisted in `product_action.action_config` as `{}` (general support) or `{"support_category": "<category>"}`.
- **Validation:**
  - Requires a plain JSON object. Rejects arrays, primitives, nested objects, and unknown keys.
  - Optional `support_category` must match one of the store's configured categories from `bot_setting.support_category`.
- **Truthful Availability:**
  - If a stored category was removed from store settings, the UI displays it honestly as `(Unavailable / Removed)` without mutating the database on load.
  - Safe deactivation is allowed without requiring replacement. Activating an action with an unavailable category requires selecting a valid category or clearing to general support.

### 2.4. `NAVIGATE_CATALOG`
- **Storage:** Persisted in `product_action.navigate_category_id` OR `product_action.navigate_product_id` (mutually exclusive).
- **Validation:**
  - Server-side UUID format verification.
  - Target must exist and must not be soft-deleted (`deleted_at IS NULL`).
  - Both target kinds cannot be submitted together.
- **Hierarchy Distinction:** Catalog navigation is a navigation jump, not an ownership tree edge. It has no effect on `parent_action_id`, ancestry cycles, or tree depth limits.
- **Truthful Availability:**
  - Inactive targets or targets with inactive ancestors are configurable, but clearly marked in UI with `(Hidden - Inactive ancestor)` or `(Hidden - Inactive category)`.
  - Soft-deleted or missing targets are marked `(Unavailable / Deleted target)`. Activating an invalid target is blocked.
  - Safe deactivation is permitted without selecting a replacement target, retaining the stored target in PostgreSQL without load mutations.

---

## 3. Atomic Type Transitions & Rollback Guarantees

When an action's type is changed, persisted fields incompatible with the new destination type are atomically cleared inside `executeAtomicBatch`:
- Leaving `OPEN_SUBMENU`: Clears `menu_text` across the base action and all translation rows. (Changing `OPEN_SUBMENU` to a terminal type while children exist remains strictly blocked).
- Leaving `SEND_TEMPLATE_MESSAGE`: Clears `template_body` across the base action and all translation rows.
- Leaving `OPEN_URL`: Clears `url` on the base action.
- Leaving `NAVIGATE_CATALOG`: Clears `navigate_category_id` and `navigate_product_id` on the base action.
- Leaving `OPEN_SUPPORT`: Clears `action_config` to `{}`.

### Neon HTTP Atomic Batch
On production Neon HTTP, `db.batch([...])` executes base attribute updates, translation updates, and incompatible-field cleanups in a single HTTP batch roundtrip. If any statement or constraint fails, all operations roll back together, leaving the database unchanged.

### Administrative Safety Banner
In the edit drawer, changing the type selector displays an informative warning banner detailing which saved attributes will be cleared upon saving. Modifying a selector in the browser does not mutate the database until "Save Changes" is submitted.

---

## 4. Source Files Matrix

| File | Purpose |
|---|---|
| `src/lib/product-actions/constants.ts` | All 7 action types enabled in `SUPPORTED_ACTION_TYPES`, placeholder allowlist, max lengths. |
| `src/lib/product-actions/templates.ts` | Action message template validation, placeholder syntax checks, single-pass non-recursive interpolation. |
| `src/lib/product-actions/validation.ts` | WHATWG HTTPS URL validation, `OPEN_SUPPORT` action config validation, parameter exclusivity checks across all 7 types. |
| `src/lib/product-actions/status.ts` | Translation status resolution including `template_body`. |
| `src/lib/product-actions/index.ts` | Barrel export including action message templating. |
| `src/lib/data/actions.ts` | Server-only data access with atomic type-transition cleanup and target validations across all 7 types. |
| `src/app/actions/product-actions.ts` | Authoritative Server Actions with `requireAdmin()`, input extraction, URL validation, and store settings verification. |
| `src/components/dashboard/catalog/types.ts` | Extended `CatalogViewData` with store `supportCategory`. |
| `src/app/(dashboard)/catalog/page.tsx` | Propagates `supportCategory` from `readSettings` into catalog view data. |
| `src/components/dashboard/catalog/catalog-editor.tsx` | Passes categories, products, and store settings down to `ProductActionEditor`. |
| `src/components/dashboard/catalog/product-action-editor.tsx` | UI creation form and edit drawer supporting all 7 types, live template preview, placeholder chips, target pickers, type-transition warnings, and RTL support. |
| `src/lib/product-actions/__tests__/validation.test.ts` | Unit tests for action types, URL validation, action config, template syntax, character bounds, and parameter exclusivity. |
| `src/app/actions/__tests__/product-actions.test.ts` | Server action unit tests covering authorization, input handling, and validation errors. |
| `tests/db/product-actions-persistence.test.ts` | PostgreSQL integration tests for persistence, reload, type-transition cleanup, and rollback of all 4 new types. |
| `scripts/test-product-actions-browser-acceptance.mjs` | Browser acceptance suite (Scenarios 1–11) verifying end-to-end UI interaction, draft preservation, reload persistence in DOM and PostgreSQL, and mobile layout. |

---

## 5. Verification Evidence

1. **ESLint (`npm run lint`):** Passed with 0 errors and 0 warnings.
2. **TypeScript (`npm run typecheck`):** Passed with 0 errors.
3. **Unit Tests (`npm test`):** Passed (30 test files passed, 474 tests passed, 0 failures).
4. **Database Integration (`npm run test:db`):** Passed (15 test files passed, 177 tests passed against disposable PostgreSQL, 0 failures).
5. **Schema Drift Check (`npm run db:check`):** Passed (`Everything's fine 🐶🔥`, 0 schema drift).
6. **Production Build (`env -u DATABASE_URL npm run build`):** Succeeded with DATABASE_URL unset.
7. **Browser Acceptance (`npm run test:browser:actions`):** All 11 scenarios passed, including Scenario 11 verifying UI creation, configuration, draft preservation, reload persistence in DOM and PostgreSQL, validation failure rejection, safe navigation deactivation with soft-deleted target, and 360px touch targets (>=44x44px).

---

## 6. Remaining Limitations & Boundaries

The following remain outside this feature slice:
- **Tree Maintenance:** Action moving/reparenting, manual reordering, and action deletion remain separate.
- **Phase 06:** Telegram bot onboarding, webhook delivery, runtime navigation, and callback query handling.
- **Phase 07 & 09:** Customer inquiries, inquiry state progression, and seller inbox.
- **Phase 08:** Payments / Telegram Stars integration (deferred per ADR-013).
- **Phase 10:** Release hardening and performance optimization.
