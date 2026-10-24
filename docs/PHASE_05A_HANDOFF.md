# Phase 05-A Handoff: First Usable Category & Product Editor

## 1. Overview and Intent

Phase 05-A implements the first usable administrative catalog slice in Rabet (رابط):
**Sign in → open Catalog → create a root category → create a nested category → create a product in that category → edit its content and displayed price → save → reload → see persisted values.**

This slice replaces the `/catalog` placeholder with a functional, mobile-first category and product management interface while preserving strict database boundaries, server-side authorization, atomic rollback semantics, and clean database availability state handling.

This phase intentionally does **not** complete Phase 05. Remaining catalog capabilities (button/interaction trees, Telegram runtime navigation, moving/reordering/archiving records, and inquiries) remain explicitly deferred to Phase 05-B and later phases.

---

## 2. Scope Matrix

### Implemented in Phase 05-A

| Area | Feature | Implementation Details |
|---|---|---|
| **Route & States** | `/catalog` Page | Server component handling State A (no `DATABASE_URL`), State B (database unavailable), State C (store settings unconfigured with link to `/settings`), State D (catalog editor). Implements `connection()` and `requireAdmin()`. Zero writes on initial page load. |
| **Category Management** | Hierarchy & Indentation | Recursive tree builder (`buildCategoryHierarchy`) flattening categories with hierarchy depth indentation, child counts, product counts, and expand/collapse support. |
| **Category Management** | Traversal Safeguards | `MAX_CATEGORY_DEPTH_SAFEGUARD = 64` traversal safeguard preventing infinite recursion or stack exhaustion without imposing arbitrary schema depth limits. |
| **Category Management** | Inactive Ancestor Explanations | Customer visibility resolution (`effectiveVisibility`): if an active category has any inactive ancestor, the admin UI displays an explicit warning badge (`Hidden: Parent is Inactive`) explaining why the category will not be customer-visible. |
| **Category Management** | Creation & Editing | Admin can create root categories or nested categories under any non-deleted parent. Slugs, localized names, descriptions, and active/inactive status can be edited and saved. New categories start inactive. |
| **Product Management** | Scoped Creation & Editing | Products are created under a selected non-deleted category. Slugs, localized names, short descriptions, details, displayed prices, and active/inactive status can be edited and saved. New products start inactive. |
| **Pricing** | Exact Decimal Contract | Price validation (`validatePrice`) strictly enforces non-negative exact decimals matching PostgreSQL `numeric(18,2)`: no exponents, no floating-point arithmetic or precision loss, maximum 2 decimal places, with 0 being valid. Displayed with the store's configured currency code without purchase or checkout behavior. |
| **Sibling Ordering** | Safe Append Position | Category sibling sort orders are calculated taking into account both active and soft-deleted rows covered by the partial unique indexes `category_sibling_sort_order_idx` and `category_root_sort_order_idx`. |
| **Atomic Persistence** | Rollback Guarantees | Atomic creation of base records (`category` or `product`) and their initial default-language translation (`category_translation` or `product_translation`). `executeAtomicBatch` utilizes `db.batch` on Neon HTTP, falling back cleanly to transactional execution on non-batch drivers. |
| **Localization** | Multi-Language Support | Requires usable content in the store's configured default language (`en`). Supports editing optional registered Arabic (`ar`) with native RTL (`dir="rtl"`). Editing disabled Arabic is permitted without activating the language globally. Saving one language translation strictly preserves existing translations in other languages. |
| **Mobile & Touch UX** | Responsive Design | Fluid layout tested at 360 px viewport without horizontal overflow. All interactive elements meet or exceed 44 × 44 CSS px touch target standards. |

### Explicitly Deferred to Phase 05-B and Later Phases

- **Product action & button tree editing** (recursive multi-level button interaction hierarchy defined in ADR-014).
- **Telegram runtime navigation & webhook handling** (browsing menus, inline keyboard callbacks, product display in chat).
- **Inquiry creation & messaging** (starting customer conversations from catalog items).
- **Reparenting or moving existing records** (categories or products changing parents).
- **Manual reorder controls & drag-and-drop ordering**.
- **Archive / soft-delete / restore controls** for categories and products.
- **Bulk imports/exports, batch edits, or image uploads**.
- **Per-product currency overrides, currency conversions, or payment checkouts**.

---

## 3. Architecture & Persistence Decisions

### 3.1. Zero-Migration Schema Reuse
Phase 05-A strictly reuses the existing tables created in Phase 03B:
- `category` (`id`, `parent_id`, `slug`, `sort_order`, `is_active`, `deleted_at`, `created_at`, `updated_at`)
- `category_translation` (`id`, `category_id`, `language_id`, `name`, `description`, `created_at`, `updated_at`)
- `product` (`id`, `category_id`, `slug`, `price`, `sort_order`, `is_active`, `deleted_at`, `created_at`, `updated_at`)
- `product_translation` (`id`, `product_id`, `language_id`, `name`, `short_description`, `details`, `created_at`, `updated_at`)

No database migrations were created or modified.

### 3.2. Neon HTTP Driver Batch Contract (`executeAtomicBatch`)
The production application uses `@neondatabase/serverless` with Drizzle's `neon-http` driver, which does not support interactive SQL transactions (`BEGIN`/`COMMIT` across roundtrips) but supports batched atomic operations via `db.batch([...])`.

In `src/lib/data/catalog.ts`:
```ts
export async function executeAtomicBatch(
  db: DatabaseClient,
  queries: BatchableQuery[],
): Promise<void> {
  const batchFn = (db as unknown as { batch?: (q: BatchableQuery[]) => Promise<unknown> }).batch;
  if (typeof batchFn === "function") {
    await batchFn.call(db, queries);
    return;
  }
  // Fallback for standard transactional drivers (e.g. postgres-js in integration tests)
  await (db as unknown as { transaction: (cb: (tx: any) => Promise<void>) => Promise<void> })
    .transaction(async (tx) => {
      for (const q of queries) {
        await tx.execute(q.getSQL());
      }
    });
}
```
This guarantees atomic rollback: if translation persistence fails, the base category or product is never orphaned in the database.

### 3.3. Sort Order Collisions & Tombstone Indexes
The database schema defines unique partial indexes:
- `category_root_sort_order_idx` ON `category (sort_order) WHERE parent_id IS NULL`
- `category_sibling_sort_order_idx` ON `category (parent_id, sort_order) WHERE parent_id IS NOT NULL`

Crucially, these partial indexes do **not** filter out soft-deleted records (`deleted_at IS NOT NULL`). To prevent duplicate key collisions (`23505`), next-sort-order queries inspect all rows under that parent (including soft-deleted rows):
```ts
const [maxOrderRow] = await db
  .select({ maxOrder: sql<number | null>`max(${category.sortOrder})` })
  .from(category)
  .where(parentId ? eq(category.parentId, parentId) : isNull(category.parentId));
```

### 3.4. Localization Fallback Contract
`src/lib/catalog/status.ts` implements `resolveCatalogTranslationStatus`, preserving the truthful translation contract:
1. Exact match in requested language if content exists.
2. Fallback to configured default store language (`en`).
3. Explicit missing translation state (`isMissing: true`, placeholder: `"[Untranslated]"`).
4. Editing an untranslated language preserves existing translations in other languages.

---

## 4. Key Source Files

- **Domain Logic & Validation**:
  - `src/lib/catalog/validation.ts`: Exact decimal validator `validatePrice`, `validateSlug`, `validateName`, `validateDescription`, `validateDetails`, `validateUuid`, `validateBoolean`.
  - `src/lib/catalog/status.ts`: Translation fallback resolver `resolveCatalogTranslationStatus`.
  - `src/lib/catalog/tree.ts`: Traversal depth safeguard (`MAX_CATEGORY_DEPTH_SAFEGUARD`), cycle protection, breadcrumbs, and `effectiveVisibility` calculation.
  - `src/lib/catalog/index.ts`: Barrel export.
- **Server Data Access**:
  - `src/lib/data/catalog.ts`: Server-only functions `listCatalogCategories`, `listCatalogProducts`, `readCatalogCategory`, `readCatalogProduct`, `createCatalogCategory`, `updateCatalogCategory`, `saveCatalogCategoryTranslation`, `createCatalogProduct`, `updateCatalogProduct`, `saveCatalogProductTranslation`, and `executeAtomicBatch`.
  - `src/lib/data/index.ts`: Data-access barrel exports.
- **Server Actions**:
  - `src/app/actions/catalog.ts`: `createCategoryAction`, `updateCategoryAction`, `createProductAction`, `updateProductAction` with authoritative `requireAdmin()` check prior to any database access.
- **UI Components & Route**:
  - `src/app/(dashboard)/catalog/page.tsx`: `/catalog` route entrypoint with States A, B, C, D.
  - `src/components/dashboard/catalog/catalog-editor.tsx`: Complete catalog management client component with category tree, product listings, edit drawers, and translation tabs.
  - `src/components/dashboard/catalog/catalog-store-setup-required.tsx`: Guidance component for State C (linking to `/settings`).
  - `src/components/dashboard/catalog/types.ts`: Catalog dashboard types and contracts.
- **Acceptance Scripts**:
  - `scripts/test-catalog-browser-acceptance.mjs`: Chromium/CDP browser acceptance runner testing production build and disposable PostgreSQL across all 8 user scenarios.

---

## 5. Verification Results

### 5.1. Static Analysis & Build
- `npm run lint`: **0 errors, 0 warnings**.
- `npm run typecheck`: **0 TypeScript errors**.
- `env -u DATABASE_URL npm run build`: **Succeeded** (Turbopack production build with partial prerendering; dynamic catalog route configured with `connection()`).
- `npm run db:check`: **Clean** (no schema drift).

### 5.2. Unit & Integration Tests (`npm test` & `npm run test:db`)
- **Unit Suite (`vitest run`)**:
  - 26 test files passed, 12 skipped (unconfigured optional services).
  - 372 tests passed, 148 skipped.
  - Includes dedicated suites:
    - `src/lib/catalog/__tests__/validation.test.ts` (14 tests)
    - `src/lib/catalog/__tests__/status.test.ts` (7 tests)
    - `src/lib/catalog/__tests__/tree.test.ts` (8 tests)
    - `src/app/actions/__tests__/catalog.test.ts` (11 tests)
    - `src/lib/data/__tests__/driver-contract.test.ts` (3 tests)
    - `tests/catalog-page.test.ts` (4 tests)
- **Database Suite (`npm run test:db`)**:
  - 13 test files passed, 154 tests passed.
  - `tests/db/catalog-persistence.test.ts` (8 tests): verified category hierarchy, nesting, product creation, decimal price validation, atomic rollback on translation error, duplicate slug rejection, deleted parent rejection, and sort ordering against disposable PostgreSQL.

### 5.3. Real Browser Acceptance (`npm run test:browser:catalog`)
Automated headless Chromium CDP suite run against a production Next.js build and an isolated loopback PostgreSQL fixture:
1. **Scenario 1 (Security)**: Unauthorized access to `/catalog` redirects to `/login`. (Passed)
2. **Scenario 2 (Zero Writes)**: Empty catalog loads without performing database writes. (Passed)
3. **Scenario 3 (Category Hierarchy)**: Created root category ("Software") and child category ("SaaS Tools"); page reload confirmed persistence. (Passed)
4. **Scenario 4 (Product Persistence)**: Created product ("Cloud Suite"), updated price to `49.99` and name; reload confirmed persistence. (Passed)
5. **Scenario 5 (Localization & RTL)**: Saved Arabic translation ("حزمة سحابية"); verified `dir="rtl"` and English preservation. (Passed)
6. **Scenario 6 (Validation & Drafts)**: Invalid price submitted; input preserved on form, rejected by validator, 0 database mutation. (Passed)
7. **Scenario 7 (Ancestor Inactive Notice)**: Inactivated root category; verified child category displays inactive ancestor warning. (Passed)
8. **Scenario 8 (Mobile Layout & Touch Targets)**: 360 px viewport verified without horizontal page scroll (`scrollWidth === clientWidth`); buttons meet 44 × 44 CSS px targets. (Passed)

---

## 6. Known Limitations & Operational Notes

1. **Reparenting and Deletion**:
   - Categories and products cannot currently be moved to a different parent category or deleted from the admin UI.
   - Deletion and reparenting controls are deferred to Phase 05-B.
2. **Button Interactions**:
   - Products currently store metadata and displayed prices. Interactive multi-level button trees (ADR-014) are deferred to Phase 05-B.
3. **Customer Telegram Navigation**:
   - Catalog browsing via Telegram inline keyboards is deferred to Phase 06.
