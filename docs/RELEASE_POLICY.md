# Nokmel — Release and Environment Policy

**Version:** 2.0 · **Updated:** 27 November 2026 · **Owner approvals required for Production.**

## Canonical environments

| Environment | Service | URL | Deployment rule | Data rule |
|---|---|---|---|---|
| **Staging** | Render `nokmel-cod-staging` (`srv-dc2ao2e8bjmc73f5cjig`) | `https://nokmel-cod-staging.onrender.com` | Auto-deploy is off. Deploy an exact, reviewed SHA through the guarded workflow and verify Render plus `/api/healthz`. | Dedicated Staging database and synthetic/test data only. Never share Production bots, customers, orders or credentials. |
| **Production** | Render `Nokmel` (`srv-dbup2f0ae00c73f71g20`) | `https://rabet-28dn.onrender.com` | Auto-deploy is off. Owner-approved, exact-SHA release only. | Separate Production Neon project/branch and live business data. Never copy the Staging database into Production. |

These are the only persistent environments. PR previews, temporary databases and disposable local databases are not extra shared Staging environments. The Render Staging service currently reports `feat/cod-order-first-slice` as its connected branch, with auto-deploy off; the guarded workflow deploys an explicitly pinned SHA. Verify this configuration before changing it.

## Last verified baseline

- GitHub `main`: PR #63 merged at `a4fab9b2f41dab83e2b3a064a627d432ea06091c`.
- Permanent Staging: live `d914f6c10ade37559b77d8652e3add6738a6c3ba`, deploy `dep-dc4ue0h7lnhs739tujr0`; verify health before relying on this snapshot.
- Production: live `28c1c1572e53771259924bd2c4e51812de59ad11`, deploy `dep-dc1ind68bjmc73ck3q8g` (last recorded 22 November 2026). It does not yet contain the post-#63 release.
- Verify all three again at the start of a release task. This document is a snapshot, not a live monitor.

## Pull requests and approvals

1. One PR contains one coherent capability or related repair batch. Required CI, dependency audit, image verification and applicable database/browser acceptance must pass on the exact final head.
2. Draft means not ready to merge. ChatGPT reviews the change and evidence, then gives a recommendation. **Ammar alone merges.**
3. No automatic deployment to Production. No Production migration, deploy, feature activation, bot setup or real-data change without Ammar's explicit approval.
4. Staging deploys are also explicit and SHA-pinned. Before live Muse acceptance, verify its exact SHA. Stop immediately on a mismatch; do not repeat already proven steps.
5. Keep browser/desktop acceptance separate from physical Android/PWA acceptance. Mobile device work may be deferred in its own file and must not hold up development, CI or routine PR review.

## Production release sequence

1. Confirm the exact merged `main` SHA and green required workflows on that SHA.
2. Review the code diff and migration sequence independently. Classify migration risk and confirm Production target identity using read-only checks.
3. Create and verify an appropriate Production recovery point before any schema/data write. Test rollback limits; code rollback does not undo a migration.
4. Run only the approved migration on the pinned Production target, then verify ledger, schema and invariants.
5. Deploy the exact SHA to Production manually. Verify Render Live, full `/api/healthz` SHA, login and critical smoke paths.
6. Activate merchant access or customer-facing operations only after a separate explicit approval. Staging fixtures and QA test orders are not copied over.

If any identity, migration, health, data-preservation or acceptance check fails, stop and report the blocker. Do not improvise a second environment or silently change flags.
