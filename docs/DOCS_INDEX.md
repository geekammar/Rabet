# Nokmel — Documentation Index and Reading Tiers

**Updated:** 27 November 2026

## Read in every coding/review session — Tier 0/1

1. `AGENTS.md` — short agent rules and read order.
2. `docs/PRODUCT_BRIEF.md` — approved scope and product invariants.
3. `docs/CURRENT_STATE.md` — last verified product, GitHub and environment snapshot; recheck live facts before changes.
4. `docs/ROADMAP.md` — next milestone and sequence.
5. `docs/RELEASE_POLICY.md` — Staging/Production and approval rules.

## Read only for the assigned capability — Tier 2

- `docs/NOKMEL_ARCHITECTURE_BLUEPRINT.md` — boundaries, tenancy, commerce and channel invariants.
- Project Source: `NOKMEL_STOREFRONT_AND_MERCHANT_UX_DESIGN.md` — complete Telegram buyer and merchant UX requirements.
- Project Source: `NOKMEL_DISCOVERY_AND_MVP_STRATEGY.md` — hypotheses, interviews, pilot measurement.
- Existing domain/runbook document only when the task touches that exact system (e.g., Vodafone Cash, notification bot, Neon or Render).

## History and evidence — Tier 3

The following files preserve older Rabet phases, original single-store design, schema history, implementation handoffs and dated deployment procedures. Read only to understand a specific legacy behavior or migration; never treat their scope, provider, environment, status or release steps as current without reconfirmation.

- Root: the original `README.md` content and all records that call the product Rabet.
- Architecture/data: `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/SAAS_MVP_ARCHITECTURE.md`, `docs/SAAS_MVP_DELIVERY_AND_BACKFILL.md`, `docs/S1.2_TENANT_OWNERSHIP.md`, `docs/S1.3A_SAAS_DATA_ARCHITECTURE.md`, `docs/TRANSACTION_DB_CLIENT.md`.
- Phase records: `docs/PHASE_02_HANDOFF.md`, `docs/PHASE_03B_HANDOFF.md`, `docs/PHASE_03C_A_HANDOFF.md`, `docs/PHASE_04A_HANDOFF.md`, `docs/PHASE_04B_HANDOFF.md`, `docs/PHASE_05A_HANDOFF.md`, `docs/PHASE_05B1_HANDOFF.md`, `docs/PHASE_05B2_HANDOFF.md`, `docs/PHASE_06A_HANDOFF.md`, `docs/PHASE_06B_HANDOFF.md`, `docs/PHASE_07_HANDOFF.md`, `docs/PHASE_07_IMPLEMENTATION_NOTE.md`, `docs/PHASE_09_HANDOFF.md`, `docs/PHASE_10A_LAUNCH_READINESS.md`, `docs/PHASE_10B_PRODUCTION_PREPARATION.md`.
- Operations and old security: `docs/NEON_DEV_SETUP.md`, `docs/NEON_DEV_ACTIONS_HANDOFF.md`, `docs/NEON_SETUP_HANDOFF.md`, `docs/RENDER_DEPLOYMENT.md`, `docs/PRODUCTION_PLATFORM_ADMIN_BOOTSTRAP.md`, `docs/SECURITY_NEXTJS_PATCH_HANDOFF.md`.
- Feature history: `docs/MANUAL_PAYMENT_JOURNEY_PROTOTYPE.md`, `docs/manual-vodafone-cash.md`, `docs/SELLER_NOTIFICATIONS_HANDOFF.md`, `docs/review/pr22/README.md`, `docs/review/cod-order-operations/README.md`.
- `docs/PROGRESS.md` is a historical project diary. Current progress is in `docs/CURRENT_STATE.md`.

Do not load all Tier 3 documents into every agent prompt. If a legacy document conflicts with Tier 0/1 or the current product sources, stop and report the conflict. The product owner decides any change to approved scope.
