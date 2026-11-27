# Nokmel — First Launch Roadmap

**Updated:** 27 November 2026 · Work in larger coherent PR batches, with CI per PR. This is the adopted order; implementation details require the preceding code audit.

## 0. Documentation and baseline consolidation

Establish the tiered source of truth, archive obsolete Rabet handoffs, and verify GitHub, Staging, Production and migration state. No code or data change.

## 1. First sellable product and Telegram storefront — next

Deliver one coherent merchant-to-buyer vertical slice:

1. Merchant can create/edit a product with image, stable catalog name/content, description, price, category and availability/stock semantics appropriate to the pilot.
2. Merchant configures store-level COD/manual Vodafone Cash availability and a clear delivery fee or policy.
3. Merchant sees readiness, previews the real Telegram storefront and explicitly publishes.
4. Buyer sees a polished welcome/catalog/product experience, browses/searches, adds to a persistent cart, asks the seller without losing context, and completes the supported checkout.
5. One confirmation creates one order and one inventory reservation. The buyer receives a durable receipt and truthful order status.
6. Merchant can find and process the order from a mobile-first dashboard. UI locale is localized while catalog text stays stable.

Start with a read-only gap audit. Split implementation into connected PRs only where dependencies or reviewability require it. Do not build Favorites or advanced filters as first-slice blockers; keep them P1.

## 2. Complete Starter operations and acceptance

Complete Needs Attention, manual payment review, customer-data correction before shipment, controlled cancellation, manual fulfillment, Merchant Notification Bot behavior, and buyer order-history paths. Prove both stores remain isolated and that notification failures do not lose orders.

## 3. Release candidate on permanent Staging

Use one pinned `main` candidate, exact SHA verification, green CI, migration review, data recovery plan, browser/desktop acceptance, Telegram Web acceptance and recorded product outcomes. Run Android/PWA installation checks separately in the deferred device-testing document.

## 4. Production promotion

Only after the owner reviews the exact candidate and explicitly approves migration/deploy. Follow `NOKMEL_RELEASE_POLICY.md`. Never copy Staging test data, bots, orders or database into Production.

## Later tiers

- **Growth:** test grounded guided shopping and separately assess AI-assisted order capture from forwarded text.
- **Pro:** Telegram Mini App on the same commerce contracts.
- **Intelligence:** scoped merchant assistance and, only after evidence and safeguards, bounded delegated actions.
- Additional channels and paid plan automation follow validated demand, partner feasibility and unit economics.

## Parallel work rule

Keep desktop CI, code review, documentation and independent low-risk work moving. Do not run parallel feature branches that change the same schema, checkout state machine, Staging fixtures or acceptance session. Do not wait for device testing to continue development or merge independently verified code.
