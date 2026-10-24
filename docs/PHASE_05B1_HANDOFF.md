# Phase 05-B1 Handoff: First Recursive Product Action Editor

## 1. Overview and Intent

Phase 05-B1 implements the first recursive, reviewable administrative product action editor in Rabet (رابط):
**Sign in → open Catalog → select an existing product → open its Buttons editor → create a root submenu → create a nested submenu → add a details button and an inquiry button → edit a translation → save → reload → see the exact same persisted tree.**

This slice is strictly focused on configuration of product actions (buttons). It does **not** execute Telegram actions, create inquiries in the database, send chat messages, or evaluate customer journeys.

This slice preserves strict database integrity boundaries, server-side authorization (`requireAdmin()`), Neon HTTP atomic batch persistence (`executeAtomicBatch`), runtime traversal and nesting safeguards, truthful availability reporting, and draft preservation across languages.

No migrations or schema changes were created or authorized. Phase 05-B1 completely reuses the existing `product_action` and `product_action_translation` tables and PostgreSQL triggers.

---

## 2. Scope Matrix

### Implemented in Phase 05-B1

| Area | Feature | Implementation Details |
|---|---|---|
| **Entry Point & Scoping** | Catalog Editor Integration | Direct entry point buttons (`Buttons` / `Manage Buttons`) from the Catalog Editor product list item, product edit card header, and product edit card footer. Navigates into the focused `ProductActionEditor` view scoped strictly to the selected product. |
| **Hierarchy & Tree** | Recursive Tree Presentation | Mobile-first indented list showing root actions and nested children with expand/collapse toggles, child count badges, active status indicators, and truthful visibility badges. |
| **Action Types** | Three Approved Action Types | Implements `OPEN_SUBMENU`, `SHOW_DETAILS`, and `START_INQUIRY`. Rejects submissions of deferred types with clean validation errors. |
| **Parenting Rules** | Submenu Only Parenting | Children can only be added beneath `OPEN_SUBMENU` actions. Adding children under `SHOW_DETAILS` or `START_INQUIRY` is blocked in UI and rejected on the server. Changing an `OPEN_SUBMENU` to a terminal type while children exist is rejected with safe feedback. |
| **Product Ownership** | Immutable Product Scope | Actions strictly belong to one product. Parent-child relationships enforce same-product ancestry at both the application layer and via PostgreSQL trigger `product_action_check_ancestry`. Cross-product parenting is rejected. |
| **Operational Safeguards** | Named Application Constants | `ACTION_DEPTH_WARNING_THRESHOLD = 8`: UI visual warning banner.<br>`MAX_ACTION_DEPTH = 16`: Form disables adding children and server rejects creation.<br>`MAX_ACTIVE_CHILDREN = 20`: Warning when active children count exceeds limit.<br>`MAX_ACTION_DEPTH_SAFEGUARD = 64`: Traversal cycle and stack exhaustion safeguard during tree construction. |
| **Truthful Availability** | Effective Visibility Resolution | `effectiveVisibility`: An action is customer-visible only if it is active AND all its ancestors, its parent product, and the parent category are active. An active action under an inactive ancestor is clearly labeled `Active (Hidden)` in the UI. |
| **Creation & Ordering** | Atomic Creation & Sibling Appends | Deterministic sibling sort order calculation (`MAX(sort_order) + 1`). Atomic commit of base action and required default-language translation. Concurrent sort conflicts return safe, retryable feedback. |
| **Editing & Rollback** | Atomic Edit Operations | Base action properties (`actionType`, `isActive`) and the active language translation (`label`, `menuText`) commit atomically via `executeAtomicBatch`. If a translation write fails, base action updates are not committed. |
| **Localization** | Multi-Language & Draft Preservation | Required label in configured store default language (`en` or `ar`). Registered optional Arabic supported with native RTL (`dir="rtl"`). Editing disabled Arabic preserves disabled status. In UI, unsaved edits in one language tab are preserved when saving or switching to another language tab. |
| **Character Constraints** | Unicode Character Counting | Action labels: 1 to 64 Unicode code points. Submenu menu texts: 0 to 4096 Unicode code points. Accurate code-point counting matching PostgreSQL character semantics. |
| **Mobile & Touch UX** | Responsive Design | Fluid layout tested and verified at 360 px viewport with zero horizontal overflow. All interactive buttons and checkboxes meet or exceed the 44 × 44 CSS px target requirement. |
| **Availability States** | Outage & Missing Data Safety | Safely handles missing `DATABASE_URL`, database connection failures, unconfigured store settings, non-existent or deleted products, and empty action trees (with zero writes on initial page load). |

### Explicitly Deferred to Phase 05-B2 and Later Phases

- **Deferred action types**: `SEND_TEMPLATE_MESSAGE`, `OPEN_URL`, `OPEN_SUPPORT`, `NAVIGATE_CATALOG`. (Pre-existing records with these types are preserved without conversion or deletion, but new submissions are rejected).
- **Reparenting or moving actions** across different parents.
- **Manual reordering** of sibling actions (future reordering will use simple controls; drag-and-drop is not required).
- **Deleting or archiving actions** (soft-delete / hard-delete; note `product_action` has no `deleted_at` column and cascades on product delete).
- **Bulk action management or tree templating**.
- **Telegram bot runtime execution & callback query handling** (deferred to Phase 06).
- **Inquiry creation & conversation handling** (deferred to Phase 07 / Phase 09).

---

## 3. Architecture, Integrity & Persistence Decisions

### 3.1. Zero-Migration Schema Reuse
Phase 05-B1 creates no migrations and alters no tables. It directly targets the schema established in Phase 03B:
- `product_action` (`id`, `product_id`, `parent_action_id`, `action_type`, `action_config`, `sort_order`, `is_active`, `created_at`, `updated_at` — note `product_action` has no `deleted_at` column)
- `product_action_translation` (`id`, `action_id`, `language_id`, `label`, `menu_text`, `created_at`, `updated_at`)

Database constraints and triggers serve as the definitive integrity boundary:
- Trigger `product_action_check_ancestry`: Enforces same-product ancestry and prevents self-parenting and cross-product parent references.
- Trigger `product_action_guard_menu_capability`: Enforces that non-`OPEN_SUBMENU` actions cannot have child actions.
- Partial unique index `product_action_root_sort_order_idx`: `(product_id, sort_order) WHERE parent_action_id IS NULL`.
- Partial unique index `product_action_sibling_sort_order_idx`: `(product_id, parent_action_id, sort_order) WHERE parent_action_id IS NOT NULL`.

### 3.2. Neon HTTP Driver Batch Contract (`executeAtomicBatch`)
The production application uses `@neondatabase/serverless` with Drizzle's `neon-http` driver. Because interactive transactions (`BEGIN` ... `COMMIT` across roundtrips) are unsupported on HTTP connections, `executeAtomicBatch` executes all related queries in a single atomic roundtrip via `db.batch([...])`, with clean fallback to driver transactions for non-HTTP drivers (such as local `postgres-js` in testing).

- When creating an action, the insertion of the `product_action` row and the insertion of the initial `product_action_translation` row are batched atomically.
- When updating an action, the update to `product_action` and the upsert/update to `product_action_translation` are batched atomically.
- If either statement fails, neither commits. Verified in real PostgreSQL rollback tests.

### 3.3. Sibling Ordering & Controlled Append
When a new action is appended:
- Root actions inspect `product_action` for `WHERE product_id = ? AND parent_id IS NULL`.
- Child actions inspect `product_action` for `WHERE product_id = ? AND parent_id = ?`.
- Next sort order is calculated as `MAX(sort_order) + 1` (or `0` if empty). If a concurrent insertion occurs, unique index violations (`23505`) are caught and mapped into a structured `RabetDataError("DUPLICATE_SLUG", ...)` with safe user feedback advising to retry.

### 3.4. Traversal & Safeguards as Application Constants
Safeguards are kept in application code rather than arbitrary schema constraints:
```ts
export const ACTION_DEPTH_WARNING_THRESHOLD = 8;
export const MAX_ACTION_DEPTH = 16;
export const MAX_ACTIVE_CHILDREN = 20;
export const MAX_ACTION_DEPTH_SAFEGUARD = 64;
```
- In `buildActionHierarchy`, cycle detection (`visited` set) and depth tracking prevent stack overflow.
- If a tree exceeds `ACTION_DEPTH_WARNING_THRESHOLD`, a visual advisory is shown.
- Creating an action beyond `MAX_ACTION_DEPTH` is blocked and rejected.
- An action containing more than `MAX_ACTIVE_CHILDREN` active children displays a visual warning.

---

## 4. Source Files Matrix

| File | Purpose |
|---|---|
| `src/lib/product-actions/constants.ts` | Action types, validation constants, depth thresholds, and action interfaces. |
| `src/lib/product-actions/validation.ts` | Strict validation for action types, labels, menu texts, parameters, and Unicode character counting. |
| `src/lib/product-actions/status.ts` | Translation status resolution (`SAVED`, `MISSING_WITH_FALLBACK`, `MISSING_NO_FALLBACK`). |
| `src/lib/product-actions/tree.ts` | Hierarchical action tree builder, cycle detection, depth tracking, active-children counting, and effective visibility resolution. |
| `src/lib/product-actions/index.ts` | Barrel export for product action domain logic. |
| `src/lib/data/actions.ts` | Server-only data access: `listProductActions`, `readProductAction`, `createProductAction`, `editProductAction` using `executeAtomicBatch`. |
| `src/lib/data/index.ts` | Exported data access functions. |
| `src/app/actions/product-actions.ts` | Server Actions (`loadProductActionsAction`, `createProductActionAction`, `updateProductActionAction`) with `requireAdmin()`, input validation, and safe error shielding. |
| `src/components/dashboard/catalog/product-action-editor.tsx` | Mobile-first hierarchical tree editor, expand/collapse, creation dialog, edit drawer, RTL Arabic tabs, and draft preservation. |
| `src/components/dashboard/catalog/catalog-editor.tsx` | Integrated Buttons entry points and view switching between catalog overview and product button editor. |
| `src/lib/product-actions/__tests__/validation.test.ts` | Unit tests for action validation and Unicode code-point counting. |
| `src/lib/product-actions/__tests__/status.test.ts` | Unit tests for translation status fallback resolution. |
| `src/lib/product-actions/__tests__/tree.test.ts` | Unit tests for tree building, cycle detection, depth limits, and visibility logic. |
| `src/app/actions/__tests__/product-actions.test.ts` | Unit tests for Server Actions verifying unauthorized calls cause 0 DB access, input validation, and safe errors. |
| `tests/db/product-actions-persistence.test.ts` | Integration tests against real disposable PostgreSQL for persistence, parent integrity triggers, atomic rollback, and sibling ordering. |
| `scripts/test-product-actions-browser-acceptance.mjs` | Automated end-to-end browser acceptance suite executing all 8 required scenarios via CDP. |

---

## 5. Verification Evidence

### 5.1. Static Analysis & Build
- `npm run lint`: **0 errors, 0 warnings** (clean).
- `npm run typecheck`: **0 errors** (clean).
- `env -u DATABASE_URL npm run build`: **0 errors** (Next.js production build succeeds with `DATABASE_URL` unset).
- `npm run db:check`: **0 schema drift** ("Everything's fine").

### 5.2. Unit & Integration Tests
- `npm test`: **30 test files passed** (424 tests passed, 160 skipped for unconfigured external services, 0 failures).
- `npm run test:db`: **15 test files passed** (166 tests passed against disposable PostgreSQL, 0 failures).
  - Includes `tests/db/product-actions-persistence.test.ts` verifying:
    1. Multi-level submenu creation and atomic persistence.
    2. Atomic rollback on translation failure (zero partial records).
    3. Same-product parent enforcement and terminal-action parent rejection (`product_action_check_ancestry`).
    4. Submenu type change rejection when children exist.
    5. Sibling sort order conflict handling.
    6. Language translation preservation.

### 5.3. Real-Browser Acceptance Suite (`npm run test:browser:actions`)
Executed against `next start` with a real disposable PostgreSQL fixture and automated Chromium CDP runner:
1. **Scenario 1 (Unauthorized Access)**: Unauthenticated request to `/catalog` redirects immediately to `/login` without writes.
2. **Scenario 2 (Empty Tree Zero-Writes)**: Navigating to an existing product's Buttons editor renders the empty state banner (`No buttons configured`) with exactly 0 rows inserted into `product_action`.
3. **Scenario 3 (Hierarchy Creation)**: Created root submenu (`Options`), nested submenu (`Tiers`), terminal `SHOW_DETAILS` (`View Specs`), and terminal `START_INQUIRY` (`Ask about this product`).
4. **Scenario 4 (Exact Hierarchy Persistence)**: Refreshed browser; verified exact tree hierarchy, `parent_action_id` relationships, sibling ordering, action types, labels, and product ownership persisted in PostgreSQL and rendered in the DOM.
5. **Scenario 5 (Language Draft Preservation)**: Typed an unsaved Arabic draft, saved English translation; verified English was committed to PostgreSQL while Arabic draft remained intact in browser without premature persistence.
6. **Scenario 6 (Validation Failure)**: Submitted empty label; form rejected submission with field error alert, and PostgreSQL database state remained completely unchanged.
7. **Scenario 7 (Transport Failure & Retry)**: Injected synthetic network failure during save; UI displayed retryable communication error alert and preserved user draft. Restored network, retried save, and verified successful commit to PostgreSQL.
8. **Scenario 8 (Mobile 360px & Touch Targets)**: Tested viewport at 360 × 800 px; verified `scrollWidth <= clientWidth` (zero horizontal overflow) and all interactive buttons/checkboxes measure at least 44 × 44 CSS pixels.
9. **Scenario 9 (Delayed-Response Reconciliation & Scoping)**: Simulated delayed server response on action mutation and product switching; proved in-flight saves do not corrupt adjacent nodes or overwrite newer inputs, and product transitions safely discard outdated responses.

---

## 6. PR #14 Safety & Save Contract Repairs

The following repairs were applied on PR #14 based on review findings:
1. **Truthful Save Contract**:
   - `updateProductActionAction` requires a supported language code (`en` or `ar`) and non-empty label whenever a translation is submitted. Missing language codes, missing labels, or unsupported language codes are rejected before database access.
   - Distinguishes intentional base-only updates from translation submissions. Omission vs explicit clearing of `menuText` is clearly handled (`undefined` retains existing value; `""` or `null` explicitly clears).
   - Parameter validation applies across all submitted languages (including optional Arabic). Submenu messages on terminal actions (`SHOW_DETAILS`, `START_INQUIRY`) are rejected rather than silently discarded.
   - `actionConfig` validation explicitly parses FormData and accepts only omitted or empty plain objects `{}`. Non-empty objects, arrays, and primitives are strictly rejected.
2. **Product Lifecycle & Deferred Records**:
   - `listProductActions`, `createProductAction`, and `editProductAction` verify the target product exists and is not soft-deleted (`deleted_at IS NULL`), returning safe `NOT_FOUND` feedback.
   - Existing deferred/unsupported action records (`OPEN_URL`, `SEND_TEMPLATE_MESSAGE`, etc.) are preserved untouched, labeled truthfully with their action type in the UI, and marked read-only. Edit submissions against them are rejected.
3. **Draft Safety & Delayed Requests**:
   - In `ProductActionEditor`, action selection is disabled while mutations are pending (`isPending`). Responses are strictly scoped by `productId`, `actionId`, and a version counter.
   - Newer draft edits made during flight are preserved rather than overwritten by server reconciliation.
   - Product transitions immediately reset actions, selection, and drafts, and ignore responses from previous products.
4. **Concurrency-Safe Active Child Limits**:
   - Active child checks for creation and activation use atomic SQL verification combined with row-level locks (`SELECT ... FOR UPDATE`) in `executeAtomicBatch`.
   - Simultaneous activations at the limit boundary are safely serialized; surplus operations roll back atomically with safe feedback.

---

## 7. Known Limitations and Remaining Work

1. **Phase 05 Scope Remains Incomplete**:
   - Phase 05-B1 covers configuration of `OPEN_SUBMENU`, `SHOW_DETAILS`, and `START_INQUIRY`.
   - Deferred action types (`SEND_TEMPLATE_MESSAGE`, `OPEN_URL`, `OPEN_SUPPORT`, `NAVIGATE_CATALOG`), reparenting, manual reordering, and action deletion belong to Phase 05-B2.
2. **Telegram Runtime Navigation**:
   - Button trees configure menu structures only; customer Telegram chat interaction belongs to Phase 06.
3. **Inquiries**:
   - `START_INQUIRY` actions specify intention; inquiry ticket creation and operator messaging belong to Phase 07 and Phase 09.
4. **Local Protocol Bridging vs Production Neon**:
   - Database tests verify batch semantics over local PostgreSQL and simulated Neon HTTP payloads. Live Neon HTTP transport and physical mobile device acceptance are verified during deployment phases.
