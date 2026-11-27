# Nokmel — Product Strategy and First Launch

**Version:** 3.0 · **Updated:** 27 November 2026 · **Owner decision:** approved direction  
**Use:** concise product authority. This describes product intent; implementation status is in `CURRENT_STATE.md`.

## Product in one sentence

Nokmel helps small merchants sell physical products through Telegram and manage the resulting orders, payments and fulfillment from one simple, mobile-first workspace.

The first market is invite-only merchants in Egypt who already have, or can bring, buyers to Telegram. That market choice is a pilot hypothesis. Product-market fit, willingness to pay and conversion lift are not yet proven.

## Four product tiers

| Tier | Customer value | Direction | Status |
|---|---|---|---|
| **Starter — Commerce Foundation** | Open a real store, receive orders and manage them safely | Telegram storefront, catalog, cart, checkout, COD and manual Vodafone Cash, basic order operations, human seller contact, mobile-first merchant dashboard and optional installable PWA | First launch scope; build and verify as one coherent sellable journey |
| **Growth — Guided Shopping** | Help buyers find suitable products and reduce repetitive merchant work | Grounded guided product discovery; separately test text-based AI order capture as a reviewable draft | Later experiment after Starter usage evidence |
| **Pro — Visual Commerce** | Make larger catalogs easier to browse | Telegram Mini App using the same catalog, cart and commerce use cases | Later, only if evidence supports it |
| **Intelligence — Assisted Commerce** | Reduce routine work with accountable assistance | Read-only answers, suggestions and eventually bounded delegated actions with explicit authorization and verified outcomes | Long-term direction; no autonomous claims in Starter |

Plans are packaging, not separate codebases or copies of store data. Entitlements must be enforced server-side. No prices or billing automation are approved in this document.

## Starter: first sellable experience

The merchant should be able to set up a store, create and publish a sellable product, connect its Store Bot, configure an available payment method and delivery fee, preview the storefront, and manage buyer orders without maintaining a separate order spreadsheet.

The buyer should be able to open the Telegram store, browse or search, understand the product and delivery cost, keep a cart while navigating or contacting the seller, submit the minimum valid delivery information, explicitly confirm once, receive one order reference and see its truthful status.

Starter includes the adopted **Storefront & Merchant UX Design System** P0 behavior. Favorites and advanced filtering remain P1 and are not required for the first coherent sellable slice unless the product owner promotes them.

### Product rules

- Physical goods first. No digital-product catalog positioning.
- Telegram first; no WhatsApp, Instagram, web checkout or Mini App promise in Starter.
- No LLM required for browsing, checkout or merchant operations.
- One order and one inventory reservation per confirmed checkout. Retries must not duplicate either.
- Payment status, order status and fulfillment status stay distinct. COD is not paid at checkout. A manual transfer becomes paid only after an authorized merchant verifies the real receipt.
- Payment methods belong to the store for the initial release. Do not add per-product payment controls without evidence that a store-level setting fails real merchant needs.
- Buyer interface language localizes UI text, labels and direction. Product/catalog content remains stable when the buyer switches interface language; merchants write product descriptions in the language(s) they choose.
- Ask Seller is a direct human Telegram contact path with product/order context where safe. It is not an in-app inbox or AI support promise.
- Store Bot serves buyers. Merchant Notification Bot serves the merchant. They have separate identity, permissions and configuration.
- The notification bot is managed from the merchant dashboard and can notify; its failure must never lose an order or block sales.
- Merchant web dashboard is mobile-first and installable as an optional PWA. Browser use remains complete. PWA installation on an actual phone has its own acceptance record.

## Commercial learning

The pilot must measure merchant setup completion, time to first published product, buyer browse-to-checkout completion, successful order handling, payment reconciliation accuracy, merchant task time, support use, retention and willingness to pay. A green CI run, a successful demo, or a created bot is not proof of commercial fit.

## Not in Starter

Public self-signup, subscription billing automation, native Telegram Payments, electronic payment links without a proven provider, carrier integrations, live shipment tracking, returns/ERP, WhatsApp/Instagram, AI-required commerce, customer-support relay, autonomous payment or fulfillment actions, Web Push and offline transaction writes.

## Next approved product phase

**First sellable product and Telegram storefront.** Audit existing flows first. Then close the end-to-end gap from merchant product creation and store delivery/payment setup through preview/publish to buyer browse, cart, confirmed order and merchant handling. Build the P0 design system in linked increments, keep Android device testing in its separate deferred file, and do not wait for that device work to continue development or ordinary PR review.

## Decision precedence

This file is the concise product authority. Detailed interaction requirements live in `NOKMEL_STOREFRONT_AND_MERCHANT_UX_DESIGN.md`; architecture constraints in `NOKMEL_ARCHITECTURE_BLUEPRINT.md`; evidence plans in `NOKMEL_DISCOVERY_AND_MVP_STRATEGY.md`; current code and release facts in `CURRENT_STATE.md` and `NOKMEL_RELEASE_POLICY.md`. Historical Rabet documents are not current requirements.
