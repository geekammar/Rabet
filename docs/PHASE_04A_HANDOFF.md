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

### Defect B: Blank store names silently ignored
- **Defect**: Submitting empty string or whitespace `displayName` converted it to `undefined` (`displayName && displayName.trim().length > 0 ? displayName.trim() : undefined`), bypassing validation, updating other fields, and reporting success while leaving the stored name unchanged.
- **Repair**:
  - `updateStoreSettings` checks `formData.has("displayName")`. If present, validates via `displayNameSchema.safeParse(raw)`.
  - Empty or whitespace-only inputs immediately fail with `{ success: false, code: "INVALID_INPUT", message: "Display name is required" }` before any database write occurs.
  - Omitted fields in partial updates (`!formData.has("displayName")`) remain `undefined` without resetting the store name.

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

### Defect E: Neighboring form omission handling
- **Defect**: Omitted support categories in partial updates cleared existing categories because `parseSupportCategories` returned `[]`.
- **Repair**:
  - `parseSupportCategories` now returns `undefined` when category fields are omitted, preserving existing categories.
  - Submitting empty category JSON state (`"[]"`) explicitly clears categories to `[]`.
  - Category length is strictly validated (max 60 chars per item) before database writes.
  - All non-async helpers in `src/app/actions/settings.ts` are kept internal (unexported) to satisfy Turbopack `"use server"` constraints.

## 3. Form Submission & Resolver Contracts

1. **Boolean fields**:
   - Omitted: `undefined` (partial update; no reset).
   - Form unchecked: submits `["false"]` -> parses to `false` -> persists `false`.
   - Form checked: submits `["false", "true"]` -> parses to `true` -> persists `true`.
2. **Support Categories**:
   - Omitted: `undefined` (partial update; no reset).
   - Form cleared: submits `supportCategoriesJson="[]"` -> parses to `[]` -> clears in DB.
   - Form items: submits items -> parses to `string[]` -> updates in DB.
3. **Translation Resolver Chain**:
   - `requested language` -> `configured default language` -> `explicitly missing`.

## 4. Test Results

All verification suites executed on VPS:

- `npm ci`: Clean install, packages audited.
- `npm run lint`: Passed with 0 errors / 0 warnings.
- `npm run typecheck`: Passed (`tsc --noEmit` exited 0).
- `DATABASE_URL= npm run build`: Passed (Turbopack production build with 14 static/prerendered routes, zero DB requirement).
- `npm run db:check`: Passed (`drizzle-kit check` verified schema/migration sync).
- `npm test`: **16 passed files, 10 skipped files (DB test files reserved for test:db), 269 passed tests, 134 skipped tests, 0 failed**.
- `npm run test:db`: **11 passed files, 0 skipped files, 140 passed tests, 0 skipped, 0 failed** (executed against disposable PostgreSQL cluster with automatic teardown).

Total tests passed: **409 passed, 0 failed**.

## 5. UI Checks & Availability States

Verified via server component tests (`tests/settings-page.test.ts`) and code inspection:
- **State A (`DATABASE_URL` unset)**: Renders `DatabaseSetupRequired` card without throwing or failing builds.
- **State B (Unreachable DB / network outage)**: Renders `DatabaseUnavailable` with safe redacted error message (`toSafeErrorMessage`), leaking no credentials or SQL connection strings.
- **State C (Empty migrated DB)**: Renders `OnboardingForm` with USD and English preselected.
- **State D (Configured DB)**: Renders `SettingsEditForm` and `LanguageSettingsCard`.
- **Authorization Boundary**: Unauthenticated access triggers `requireAdmin()` redirection before database access.
- **Mobile Responsive Design**: Clean grid layout (`grid-cols-1 sm:grid-cols-2`), touch targets meeting 44px+ minimum height (`min-h-11`, `min-h-14`), responsive submit buttons (`w-full sm:w-auto`).

*Note on Browser Testing*: The development VPS environment has no GUI/desktop browser installed. Interactive device checks on physical mobile devices and PWA installation checks remain reserved for deployed preview review.

## 6. Next Steps for Independent Review

1. Verify GitHub Actions CI passing on PR #10.
2. Verify Vercel automatic Preview deployment is READY on the latest PR head.
3. Review git diff for PR #10 to verify only settings repairs, safeguards, and tests are changed.
4. Perform interactive browser checks on the Vercel Preview URL.
5. STOP — Do not begin Phase 04-B until Phase 04-A review is accepted.
