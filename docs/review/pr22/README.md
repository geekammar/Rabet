# PR #22 Visual Acceptance Evidence

This directory contains synthetic screenshots captured during end-to-end browser acceptance tests against disposable PostgreSQL environments. All displayed data is mock/test data with zero real credentials or customer information.

1. **[01_mobile_one_language_save_reopen.png](file:///root/projects/rabet/docs/review/pr22/01_mobile_one_language_save_reopen.png)** (`docs/review/pr22/01_mobile_one_language_save_reopen.png`):
   - **Scenario**: Narrow mobile viewport (360x740) single-language save & reopen.
   - **Details**: Demonstrates an English-only payment method ("Cash on Delivery (Courier)") edited, saved, and reopened without requiring Arabic translation fields to be populated. Untouched optional language drafts do not block submission or create empty records.

2. **[02_product_button_updated_preview.png](file:///root/projects/rabet/docs/review/pr22/02_product_button_updated_preview.png)** (`docs/review/pr22/02_product_button_updated_preview.png`):
   - **Scenario**: Product button action editor showing updated central method preview.
   - **Details**: Demonstrates that editing the central payment method propagates immediately to all bound product buttons (Button 2 preview reflects "Vodafone Cash Corporate Gateway" and updated instructions).

3. **[03_disabled_method_reference_retained.png](file:///root/projects/rabet/docs/review/pr22/03_disabled_method_reference_retained.png)** (`docs/review/pr22/03_disabled_method_reference_retained.png`):
   - **Scenario**: Central payment method disabled while product button references are retained.
   - **Details**: Demonstrates that disabling a payment method preserves button bindings with a clear "(Disabled)" badge in the selection dropdown, preventing broken references.
