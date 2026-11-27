# Nokmel — Current State

**Snapshot:** 27 November 2026 · **Use:** first read for development/release sessions. Recheck live systems before acting.

## Product position

Approved direction: physical-goods-first, invite-only Telegram commerce. First launch must provide a coherent sellable product plus the P0 Telegram storefront and Merchant UX Design System. The next product phase is **First sellable product and Telegram storefront**. This file separates verified implementation from target scope.

## Verified implementation checkpoint

- PRs #59–#63 are merged on GitHub `main`; current recorded merge head is `a4fab9b2f41dab83e2b3a064a627d432ea06091c`.
- #59 separates buyer UI locale from stable catalog content.
- #60 provides a direct Ask Seller Telegram contact route with product context; live desktop acceptance passed.
- #61 provides Needs Attention order selection and exact older-order review; live Staging acceptance passed.
- #62 includes manual Vodafone Cash claim/review, merchant decisions and order/inventory integration; VF-04R and VF-13 retests passed on Staging after recovery/navigation fixes.
- #63 provides managed Merchant Notification Bot onboarding, manual fallback and connection management; Store B created, linked, test-notified and disconnected successfully on a real Android device after the official Telegram app launch fix.
- The notification bot is separate from the buyer-facing Store Bot. Notifications are optional and must not block commerce.

## Staging and Production snapshot

- Staging `nokmel-cod-staging` is live at `d914f6c10ade37559b77d8652e3add6738a6c3ba` on `https://nokmel-cod-staging.onrender.com`.
- Staging has the managed-notification migration through Drizzle ledger entry 21, including `0019` and `0020`, as last verified. Do not rerun migrations from this snapshot; inspect first.
- Production `Nokmel` remains live at `28c1c1572e53771259924bd2c4e51812de59ad11` on `https://rabet-28dn.onrender.com`, last verified 22 November 2026. Production has not received the #63 release.
- Both services have auto-deploy off. The current Render Staging service's connected branch is `feat/cod-order-first-slice`; deploy evidence must identify the actual SHA, not infer it from that branch setting.

## Known gaps before first commercial pilot

1. Merchant self-service path to create a fully sellable product needs an audit and completion across image, description, price, category, stock/availability and save/publish feedback.
2. Store-level payment and delivery-fee setup needs to be verified in the real merchant onboarding and checkout path.
3. The whole Telegram storefront must match the adopted P0 UX: welcome/home, browse/categories, search, product card, cart recovery, checkout and receipt preservation, Ask Seller, My Orders, safe navigation and one active storefront message where Telegram permits.
4. Merchant dashboard must support the same P0 journey responsively and in Arabic RTL/English LTR, with real save/error/recovery states.
5. End-to-end acceptance must prove cross-store isolation, one order/one reservation, COD/manual transfer correctness, fulfillment and cancellation, and notification failure not hiding orders.
6. Desktop/browser and Telegram Web acceptance are continuous. Physical Android/PWA installation testing remains separate and deferred; do not call it passed until its own device report exists.

## Immediate next action

Run a read-only code/UX gap audit against `PRODUCT_BRIEF.md` and the P0 checklist in `NOKMEL_STOREFRONT_AND_MERCHANT_UX_DESIGN.md`. Return a feature-by-feature `implemented / partial / missing / unverified` matrix, exact source paths, dependencies, and one sequenced vertical-slice plan. Do not deploy, migrate, alter fixtures, or start building before that audit is reviewed.
