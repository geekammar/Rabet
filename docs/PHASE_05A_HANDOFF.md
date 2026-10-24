# Phase 05-A Handoff: First Usable Category & Product Editor

## 1. Overview and Intent

Phase 05-A implements the first usable administrative catalog slice in Rabet (رابط):
**Sign in → open Catalog → create a root category → create a nested category → create a product in that category → edit its content and displayed price → save → reload → see persisted values.**

This slice replaces the `/catalog` placeholder with a functional, mobile-first category and product management interface while preserving strict database boundaries, server-side authorization, atomic rollback semantics, and clean database availability state handling.

This phase intentionally does **not** complete Phase 05. Remaining catalog capabilities (button/interaction trees, Telegram runtime navigation, moving/reordering/archiving records, and inquiries) remain explicitly deferred to Phase 05-B and later phases.

---

## 2. Scope Matrix

### Implemented in Phase 05-A & Repaired in PR #13

| Area | Feature | Implementation Details |
|---|---|---|
| **Route & States** | `/catalog` Page | Server component handling State A (no `DATABASE_URL`), State B (database unavailable), State C (store settings unconfigured with link to `/settings`), State D (catalog editor). Implements `connection()` and `requireAdmin()`. Zero writes on initial page load. |
| **Category Management** | Hierarchy & Indentation | Recursive tree builder (`buildCategoryHierarchy`) flattening categories with hierarchy depth indentation, child counts, product counts, and expand/collapse support. |
| **Category Management** | Traversal Safeguards | `MAX_CATEGORY_DEPTH_SAFEGUARD = 64` traversal safeguard preventing infinite recursion or stack exhaustion without imposing arbitrary schema depth limits. |
| **Category Management** | Inactive Ancestor Explanations | Customer visibility resolution (`effectiveVisibility`): if an active category has any inactive ancestor, the admin UI displays an explicit warning badge (`Hidden: Parent is Inactive`) explaining why the category will not be customer-visible. |
| **Category Management** | Creation & Atomic Editing | Admin can create root categories or nested categories under any non-deleted parent. Slugs, localized names, descriptions, and active/inactive status can be edited and saved atomically via `editCatalogCategory`. New categories start inactive. |
| **Product Management** | Scoped Creation & Atomic Editing | Products are created under a selected non-deleted category. Slugs, localized names, short descriptions, details, displayed prices, and active/inactive status can be edited and saved atomically via `editCatalogProduct`. New products start inactive. |
| **Pricing** | Exact Decimal Contract | Price validation (`validatePrice`) strictly requires decimal strings (rejecting JavaScript numbers to prevent precision loss) and enforces non-negative exact decimals matching PostgreSQL `numeric(18,2)`: no exponents, no floating-point arithmetic, maximum 2 decimal places, with 0 being valid. Displayed with the store's configured currency code without purchase or checkout behavior. |
| **Boolean Handling** | Strict Boolean Validation | `validateBoolean` returns `ValidationResult<boolean>`, strictly accepting boolean primitives or `"true"`/`"false"` strings, rejecting malformed, numeric, null, or undefined inputs instead of silently casting them. |
| **Sibling Ordering** | Safe Append Position | Category sibling sort orders are calculated taking into account both active and soft-deleted rows covered by the partial unique indexes `category_sibling_sort_order_idx` and `category_root_sort_order_idx`. |
| **Atomic Persistence** | Rollback Guarantees | Atomic creation and atomic edits of base records (`category` or `product`) and their translations. `executeAtomicBatch` utilizes `db.batch` on Neon HTTP, falling back cleanly to transactional execution on non-batch drivers. If translation persistence fails, base attributes remain unchanged. Verified in real PostgreSQL rollback tests (`tests/db/neon-driver-batch.test.ts`). |
| **Authoritative State** | Database Reconciliation | Server actions return authoritative saved database records rather than fabricating IDs, timestamps, or language mappings. UI state syncs directly to authoritative results. |
| **Draft Preservation** | Unrelated Language Isolation | In `catalog-editor.tsx`, saving one language preserves unsaved changes in other languages for both categories and products. Only the submitted language draft is reconciled with authoritative persistence. Form controls are disabled while mutations are pending. |
| **Default-Language Alignment** | Configured Store Alignment | Category and Product creation modals dynamically render the configured store default language name and text direction (`dir="rtl"` for Arabic, `dir="ltr"` for English). Primary inputs map to the configured default language. Optional Arabic is shown only when Arabic is registered AND not the default language, preventing redundant Arabic payloads. Active editing language tab defaults to the configured default language. Fallback displays reflect the configured default language. |
| **Resilient UI State** | Drafts & Failure Handling | Initial page load populates drafts immediately for the selected category without requiring manual clicks. Category switching initializes drafts. All mutation handlers catch network/transport errors, present fixed safe retry guidance, preserve draft inputs, keep creation dialogs open, and allow safe retry. |
| **Localization** | Multi-Language Support | Requires usable content in the store's configured default language (`en` or `ar`). Supports editing optional registered Arabic (`ar`) with native RTL (`dir="rtl"`). Editing disabled Arabic is permitted without activating the language globally. Saving one language translation strictly preserves existing translations in other languages. Rejects blank/whitespace names when translation is submitted, and distinguishes omitted translation updates from invalid submitted updates. Rejects unregistered languages. Avoids duplicate Arabic insertion when default is Arabic. |
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

### 3.2. Neon HTTP Driver Batch Contract & Atomic Edits (`executeAtomicBatch`)
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

Both category and product updates are executed atomically via `editCatalogCategory` and `editCatalogProduct`. If a translation write fails, the base category/product update is not committed, preventing partial or corrupt states.

The batch regression in `tests/db/neon-driver-batch.test.ts` connects the real `neon-http` driver via `neonConfig.fetchFunction` to a loopback PostgreSQL bridge, proving that:
1. The real `neon-http` client reaches the protocol bridge.
2. The expected multi-statement batch payload is received.
3. The first database write executes inside the transaction (verified in-flight).
4. The failing second statement triggers transaction rollback.
5. Zero base category or translation rows remain committed.

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

### 3.4. Localization Fallback Contract & Strict Validation
`src/lib/catalog/status.ts` implements `resolveCatalogTranslationStatus`, preserving the truthful translation contract:
1. Exact match in requested language if content exists.
2. Fallback to configured default store language (`en` or `ar`).
3. Explicit missing translation state (`isMissing: true`, placeholder: `"[Untranslated]"`).
4. Editing an untranslated language preserves existing translations in other languages.
5. Server action contracts enforce:
   - Blank or whitespace-only names are rejected prior to database writes.
   - Omitted translation inputs are explicitly distinguished from invalid submitted translations.
   - Language codes are validated against supported editor languages (`en`, `ar`) and registered store languages before writing.
   - Unregistered languages are rejected rather than silently dropped.
   - If the default language is Arabic, Arabic content is mapped to the default language, and redundant Arabic fields are rejected.
   - Arabic translations can be edited while Arabic remains globally disabled (`isEnabled === false`).

---

## 4. Key Source Files

- **Domain Logic & Validation**:
  - `src/lib/catalog/validation.ts`: Exact decimal validator `validatePrice` (string-only), `validateSlug`, `validateName`, `validateDescription`, `validateDetails`, `validateUuid`, strict `validateBoolean`.
  - `src/lib/catalog/status.ts`: Translation fallback resolver `resolveCatalogTranslationStatus`.
  - `src/lib/catalog/tree.ts`: Traversal depth safeguard (`MAX_CATEGORY_DEPTH_SAFEGUARD`), cycle protection, breadcrumbs, and `effectiveVisibility` calculation.
  - `src/lib/catalog/index.ts`: Barrel export.
- **Server Data Access**:
  - `src/lib/data/catalog.ts`: Server-only functions `listCatalogCategories`, `listCatalogProducts`, `readCatalogCategory`, `readCatalogProduct`, `createCatalogCategory`, `editCatalogCategory`, `updateCatalogCategory`, `saveCatalogCategoryTranslation`, `createCatalogProduct`, `editCatalogProduct`, `updateCatalogProduct`, `saveCatalogProductTranslation`, and `executeAtomicBatch`.
  - `src/lib/data/index.ts`: Data-access barrel exports.
- **Server Actions**:
  - `src/app/actions/catalog.ts`: `createCategoryAction`, `updateCategoryAction`, `createProductAction`, `updateProductAction` with authoritative `requireAdmin()` check prior to any database access, strict validation, and return of authoritative records.
- **UI Components & Route**:
  - `src/app/(dashboard)/catalog/page.tsx`: `/catalog` route entrypoint with States A, B, C, D.
  - `src/components/dashboard/catalog/catalog-editor.tsx`: Complete catalog management client component with category tree, product listings, edit drawers, translation tabs, immediate draft hydration, safe error feedback, unrelated language draft preservation, default language alignment, and retry support.
  - `src/components/dashboard/catalog/catalog-store-setup-required.tsx`: Guidance component for State C (linking to `/settings`).
  - `src/components/dashboard/catalog/types.ts`: Catalog dashboard types and contracts.
- **Integration Tests & Acceptance Scripts**:
  - `tests/db/neon-driver-batch.test.ts`: Dedicated PostgreSQL integration test proving real Neon HTTP client multi-statement batch serialization, in-transaction write verification, and transactional rollback through local bridge.
  - `tests/db/catalog-persistence.test.ts`: Integration test suite asserting atomic rollbacks, tombstone collisions, and bilingual creation and editing under English and Arabic defaults.
  - `scripts/test-catalog-browser-acceptance.mjs`: Headless Chromium/CDP browser acceptance runner testing production build and disposable PostgreSQL across all scenarios with negative controls, scoped RTL checks, transport failure injection, and category/product unrelated draft preservation regressions.

---

## 5. Verification Results

### 5.1. Static Analysis & Build
- `npm run lint`: **0 errors, 0 warnings**.
- `npm run typecheck`: **0 TypeScript errors**.
- `env -u DATABASE_URL npm run build`: **Succeeded** (Turbopack production build with partial prerendering; dynamic catalog route configured with `connection()`).
- `npm run db:check`: **Clean** (no schema drift).

### 5.2. Unit & Integration Tests (`npm test` & `npm run test:db`)
- **Unit Suite (`vitest run`)**:
  - 26 test files passed, 13 skipped (unconfigured optional services).
  - 384 tests passed, 154 skipped.
  - Includes dedicated suites:
    - `src/lib/catalog/__tests__/validation.test.ts`: **23 passed**
    - `src/lib/catalog/__tests__/status.test.ts`: **4 passed**
    - `src/lib/catalog/__tests__/tree.test.ts`: **4 passed**
    - `src/app/actions/__tests__/catalog.test.ts`: **22 passed** (includes English default and Arabic default create/edit validation)
    - `src/lib/data/__tests__/driver-contract.test.ts`: **3 passed**
    - `tests/catalog-page.test.ts`: **5 passed** (includes Arabic default language rendering)
- **Database Suite (`npm run test:db`)**:
  - 14 test files passed, 160 tests passed.
  - `tests/db/neon-driver-batch.test.ts`: **1 passed** (verified real Neon HTTP batch reaching bridge, in-transaction first write, rollback on FK violation, and zero committed rows).
  - `tests/db/catalog-persistence.test.ts`: **13 passed** (verified category hierarchy, nesting, product creation, decimal price validation, atomic rollback on translation error during create and edit, tombstone sort collisions, duplicate slug rejection, deleted parent rejection, sort ordering, and bilingual creation/editing under English and Arabic store defaults).

### 5.3. Real Browser Acceptance (`npm run test:browser:catalog`)
Automated headless Chromium CDP suite run against a production Next.js build and an isolated loopback PostgreSQL fixture:
1. **Scenario 1 (Security)**: Unauthorized access to `/catalog` redirects to `/login`. (Passed)
2. **Scenario 2 (Zero Writes)**: Empty catalog loads without performing database writes. (Passed)
3. **Scenario 3 (Category Hierarchy & Draft Population)**: Created root category ("Software") and child category ("SaaS Tools"); page reload confirmed persistence and immediate draft hydration of initial selected category without manual click. (Passed)
4. **Scenario 4 (Product Persistence)**: Created product ("Cloud Suite"), updated price to `49.99` and name; reload confirmed persistence. (Passed)
5. **Scenario 5 (Localization, Scoped RTL & English Preservation)**: Saved Arabic translation ("محرر الأكواد الاحترافي"); verified scoped `dir="rtl"` on input, English preservation on reload, and database verification that Arabic remains disabled (`language.isEnabled === false`). (Passed)
6. **Scenario 5B (Unrelated Language Draft Preservation)**: For both Category and Product: changed Arabic without saving; switched to English and saved an English change; switched back to Arabic and verified unsaved draft remained intact; reloaded page and verified that only the explicitly saved English changes were persisted to PostgreSQL while unsaved Arabic drafts were never committed. (Passed)
7. **Scenario 6 (Validation, Blank Names & Synthetic Transport Rejection)**: Invalid price and blank name rejected with 0 database mutation; synthetic transport error injected, verifying fixed safe retry guidance, draft preservation, creation dialog remaining open, and successful retry. (Passed)
8. **Scenario 7 (Ancestor Inactive Notice)**: Inactivated root category; verified child category displays inactive ancestor warning. (Passed)
9. **Scenario 8 (Mobile Layout, Touch Targets & Negative Control)**: 360 px viewport verified without horizontal page scroll (`scrollWidth === clientWidth`); undersized negative control button detected and asserted; all interactive touch targets meet or exceed 44 × 44 CSS px. (Passed)

---

## 6. Dependency Audit Evidence & Minimal Zod Security Patch

An audit of dependencies was performed using `npm audit` and `npm audit --omit=dev`:

- **Production Dependencies (`npm audit --omit=dev`)**:
  - Pinned exact patched release `"zod": "4.6.6"` in `package.json` and updated `package-lock.json`.
  - Advisory [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (Memory exhaustion while validating oversized constrained collections) has a published patched boundary at `4.6.6`.
  - `npm audit --omit=dev` output: **found 0 vulnerabilities** (exit code 0).
- **Full Dependencies (`npm audit`)**:
  - Total: **13 vulnerabilities** (8 moderate, 5 high), all residing strictly in development dependencies:
    - `@vitest/mocker` / `vitest` (GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp)
    - `body-parser` (GHSA-27r3-jxmh-p828)
    - `esbuild` / `@esbuild-kit/core-utils` / `drizzle-kit` (GHSA-67mh-4wv8-2f99)
    - `fast-uri` (GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp)
    - `ip-address` (GHSA-rxp7-6hxx-x8q5)
    - `undici` (GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c)
    - `shadcn` / `@shadcn/registry` (bundled nested zod)
- **Why `npm audit fix --force` Was Avoided**:
  - Running `npm audit fix --force` would downgrade `drizzle-kit` to `0.18.1` (a major breaking change from `0.31.11`) and break migration generation.
  - In accordance with repository safety guidelines, forced breaking dependency changes were rejected.
  - **Recommendation**: Address development tool dependencies in a dedicated dependency maintenance pull request.

---

## 7. Testing Environment & Operational Distinctions

To ensure clarity for reviewers and operators:
1. **Local CDP Browser Acceptance**:
   - Runs against a production Next.js build using headless Chromium via Chrome DevTools Protocol.
   - Connected to a dedicated disposable loopback PostgreSQL instance with local protocol translation bridge for Neon HTTP simulation.
2. **Neon HTTP Cloud Deployment**:
   - In production, `@neondatabase/serverless` communicates over HTTPS with the Neon cloud endpoint.
   - All batch operations rely on Neon's batch endpoint; verified via atomic batch driver tests.
3. **Physical Mobile & PWA Verification**:
   - The UI layout was verified programmatically down to 360 px viewport width with zero overflow and 44 × 44 CSS px touch targets.
   - Physical device verification on Android/iOS and PWA standalone mode remains recommended during end-to-end device testing.

---

## 8. Known Limitations & Operational Notes

1. **Reparenting and Deletion**:
   - Categories and products cannot currently be moved to a different parent category or deleted from the admin UI.
   - Deletion and reparenting controls are deferred to Phase 05-B.
2. **Button Interactions**:
   - Products currently store metadata and displayed prices. Interactive multi-level button trees (ADR-014) are deferred to Phase 05-B.
3. **Customer Telegram Navigation**:
   - Catalog browsing via Telegram inline keyboards is deferred to Phase 06.
