# Phase 04-A Handoff — Store Settings & Onboarding UI Repair

## 1. Git State and Commits

- **Repository**: [geekammar/Rabet](https://github.com/geekammar/Rabet)
- **Target Pull Request**: [PR #10](https://github.com/geekammar/Rabet/pull/10)
- **Feature Branch**: `feat/phase-04a-settings-ui`
- **Incorporated Main SHA (Security Patch PR #11)**: `60162b682d1351432707ee57ca533a36bcc5e77b` (Next.js 16.4.1 patch)
- **Feature Merge Commit**: `e2218b8` (origin/main merged into feat/phase-04a-settings-ui)

## 2. Defects Confirmed & Repairs Made

### Defect A: Checkbox `false` persistence
- **Defect**: HTML checkboxes submit no field value when unchecked (`formData.get("askForLanguage") === null`). The server action treated absence as `undefined`, causing unchecking to silently keep the previous `true` value in the database.
- **Repair**:
  - Added hidden inputs `<input type="hidden" name="askForLanguage" value="false" />` ahead of checkbox inputs in `SettingsEditForm` and `OnboardingForm`.
  - Implemented `parseBooleanField(formData, "askForLanguage")` in `src/app/actions/settings.ts` that safely handles multi-value FormData arrays without relying on ambiguous first-value lookups:
    - Checked submits `["false", "true"]` -> resolves `true`.
    - Unchecked submits `["false"]` -> resolves `false`.
    - Programmatic partial updates omitting the field -> resolves `undefined`, preventing accidental resets.

### Defect B: Blank store names silently ignored & form-reset on error
- **Defect**: Submitting empty string or whitespace `displayName` converted it to `undefined` (`displayName && displayName.trim().length > 0 ? displayName.trim() : undefined`), bypassing validation, updating other fields, and reporting success while leaving the stored name unchanged. Uncontrolled inputs also cleared entered user data on validation failure.
- **Repair**:
  - `updateStoreSettings` checks `formData.has("displayName")`. If present, validates via `displayNameSchema.safeParse(raw)`.
  - Empty or whitespace-only inputs immediately fail with `{ success: false, code: "INVALID_INPUT", message: "Display name is required" }` before any database write occurs.
  - Omitted fields in partial updates (`!formData.has("displayName")`) remain `undefined` without resetting the store name.
  - Form fields (`displayName`, `supportReplyTime`) use controlled React state in `SettingsEditForm` and `OnboardingForm`, preserving user-entered input across validation errors.

### Defect C: Action-level defaults inventing required initialization values
- **Defect**: `initializeStoreSettings` invented missing currency (`?? "USD"`) and language (`?? "en"`), and called `ensureLanguage` writes before validating inputs. Invalid requests (e.g., blank name or invalid currency) left orphan language rows in the database.
- **Repair**:
  - Removed all fallback defaults from the action. Requires explicit `displayName`, `currency`, and `defaultLanguageCode` in the request.
  - Complete validation runs **before** any database operation (`ensureLanguage` or `initializeSettings`).
  - Unsupported or invalid currencies and language codes fail safely with zero database writes.
  - Duplicate initialization preserves existing settings via `initializeSettings` singleton conflict handling (`ON CONFLICT DO NOTHING`).

### Defect D: Misaligned fallback copy
- **Defect**: Settings descriptions promised an unconditional fallback to English.
- **Repair**:
  - Aligned copy across `LanguageSettingsCard`, `OnboardingForm`, and `SettingsEditForm` with the actual resolver contract:
    - English is initially selected.
    - Missing requested translations fall back to the configured default language.
    - If neither translation exists, the result is explicitly missing (no placeholder fabrication).

### Defect E: Strict Support Categories Validation Contract
- **Defect**: Independent review identified that malformed JSON (`"{bad"`), non-array JSON (`"{}"`), or non-string items (`"[12]"`) were caught by a generic try-catch returning `[]`, which caused `updateStoreSettings` to silently clear existing categories.
- **Repair**:
  - Implemented `parseSupportCategories(formData)` returning a strict discriminated union:
    - `{ kind: "omitted" }`: Both `supportCategory` and `supportCategoriesJson` absent; preserves existing categories.
    - `{ kind: "valid", categories }`: Explicit `[]` (intentional clear) or valid `string[]` (trimmed, 1–60 chars, deduplicated).
    - `{ kind: "invalid", message }`: Malformed JSON, non-array structures, non-string items, empty strings, strings > 60 chars, or conflicts between `supportCategoriesJson` and `supportCategory`.
  - Applied before ANY database write in both `initializeStoreSettings` and `updateStoreSettings`.
  - Added 8 focused action regression tests covering all invalid JSON, non-array, item type, zero-write, and representation conflict scenarios.

### Defect F: Mobile Touch Targets & Responsive Layout
- **Repair**:
  - Updated interactive controls in `SupportCategoryManager`, `LanguageSettingsCard`, and `CurrencyPicker` to meet or exceed 44 x 44 CSS pixels:
    - Category action buttons (Move Up, Move Down, Edit, Delete): `size-11 min-h-11 min-w-11` (44x44px).
    - Edit row Save / Cancel buttons: `min-h-11 min-w-11 px-2.5` (44x44px).
    - Suggested category chips: `min-h-11 px-3.5 py-2` (44px min height).
    - Language settings action buttons: `min-h-11 px-4` (44px min height).
    - Currency safeguard checkbox label: `min-h-11 py-1` (44px min height).
  - Responsive layout: Category items use `flex-col sm:flex-row sm:items-center justify-between gap-2` with `break-words` and `self-end sm:self-auto` action grouping, guaranteeing 0 horizontal overflow at 360px viewport.

## 3. Form Submission & Resolver Contracts

1. **Boolean fields**:
   - Omitted: `undefined` (partial update; no reset).
   - Form unchecked: submits `["false"]` -> parses to `false` -> persists `false`.
   - Form checked: submits `["false", "true"]` -> parses to `true` -> persists `true`.
2. **Support Categories**:
   - Omitted: `undefined` (partial update; no reset).
   - Form cleared: submits `supportCategoriesJson="[]"` -> parses to `[]` -> clears in DB.
   - Form items: submits items -> parses to `string[]` -> updates in DB.
   - Invalid JSON / bad items / conflict: fails with `INVALID_INPUT` before DB writes.
3. **Translation Resolver Chain**:
   - `requested language` -> `configured default language` -> `explicitly missing`.

## 4. Verification & Browser Acceptance Results

All verification suites executed on VPS:

- `npm ci`: Clean install, packages audited.
- `npm run lint`: Passed with 0 errors / 0 warnings.
- `npm run typecheck`: Passed (`tsc --noEmit` exited 0).
- `DATABASE_URL= npm run build`: Passed (Turbopack production build with 14 static/prerendered routes, zero DB requirement).
- `npm run db:check`: Passed (`drizzle-kit check` verified schema/migration sync).
- `npm test`: **16 passed test files, 10 skipped files (DB test files reserved for test:db), 277 passed tests, 134 skipped tests, 0 failed**.
- `npm run test:db`: **11 passed test files, 0 skipped files, 140 passed tests, 0 skipped, 0 failed** (executed against disposable PostgreSQL cluster with automatic teardown).
- **Total Test Suite**: **417 passed tests, 0 failed**.

### Real Browser Acceptance Results (Headless Chromium on Local Application & Disposable PostgreSQL)

Executed against local Next.js production build (`next start`), test credentials, and disposable loopback PostgreSQL cluster:

| # | Flow | Result | Details |
|---|------|--------|---------|
| 1 | Unauthenticated access | **Passed** | Navigating to `/settings` without session redirected to `/login` |
| 2 | State A — `DATABASE_URL` unset | **Passed** | Renders "Database Setup Required" card |
| 3 | State B — Unreachable DB outage | **Passed** | Renders "Database Temporarily Unavailable", redacting credentials and connection string |
| 4 | State C — Empty migrated disposable DB | **Passed** | Renders onboarding with USD radio checked and English selected |
| 5 | Initialization & Persistence | **Passed** | Initialized "Acme Digital" with categories; reloaded and verified persistence in edit mode |
| 6 | Checkbox `false` persistence | **Passed** | Unchecked `askForLanguage`, saved, reloaded: persisted `false` |
| 7 | Checkbox `true` persistence | **Passed** | Re-checked `askForLanguage`, saved, reloaded: persisted `true` |
| 8 | Clear categories persistence | **Passed** | Deleted all categories, saved, reloaded: verified empty state displayed |
| 9 | Invalid store name handling | **Passed** | Submitting blank name showed "Display name is required" and preserved useful input (`supportReplyTime`) |
| 10 | Mobile 360px viewport & touch targets | **Passed** | Viewport 360x740: `scrollWidth === 360` (no horizontal overflow), touch targets verified >= 44x44px, category edit/delete usable |

Total Browser Flows: **10 passed, 0 failed**.

## 5. Next Steps for Independent Review

1. Verify GitHub Actions CI passing on PR #10.
2. Verify Vercel automatic Preview deployment is READY on the latest PR head.
3. Review git diff for PR #10 to verify only settings repairs, safeguards, and tests are changed.
4. Perform interactive browser checks on the Vercel Preview URL.
5. STOP — Do not begin Phase 04-B until Phase 04-A review is accepted.
