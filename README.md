# Nokmel | نكمل

Nokmel is an invite-only Telegram commerce product for merchants selling physical goods. The first release is a complete, simple selling and order-management journey, backed by shared commerce rules and a mobile-first merchant workspace.

## Read the current project documents

- [Product brief](docs/PRODUCT_BRIEF.md)
- [Verified current state](docs/CURRENT_STATE.md)
- [First-launch roadmap](docs/ROADMAP.md)
- [Release and environment policy](docs/RELEASE_POLICY.md)
- [Documentation tiers and archive index](docs/DOCS_INDEX.md)

The detailed Telegram storefront and merchant UX design system is maintained as a project source and is loaded only for UX/storefront work. The large Rabet phase notes and old deployment runbooks are historical references, not current requirements.

## Engineering approach

Use one modular monolith, explicit store scope, a separate Staging and Production environment, a reviewable PR for each coherent capability, and CI on every PR. Keep buyer UI localization separate from merchant-authored catalog content. Do not merge, migrate or deploy to Production without the owner's explicit approval.
