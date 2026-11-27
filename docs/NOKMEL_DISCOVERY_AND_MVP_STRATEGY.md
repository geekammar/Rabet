# Nokmel — Discovery and MVP Strategy

**Version:** 1.3 · **Updated:** 27 November 2026  
**Status:** discovery hypotheses and measurement plan; not proof of market fit.  
**Use:** product discovery, pilot design and prioritization. This file is not implementation status.

## The question

Can Nokmel help a specific small merchant complete the real Telegram commerce loop—from first sellable product to correctly handled delivery—simply enough that buyers complete purchases and the merchant keeps using and pays for the service?

## First segment to test

Start with small physical-goods merchants in Egypt who already have buyers on Telegram or can bring them there. Treat this as a pilot segment, not a proven market. Recruit merchants who recently handled real orders and observe the current process rather than asking only whether they like Nokmel.

## Hypotheses

| Hypothesis | Evidence to collect |
|---|---|
| Order handling across chats causes lost or delayed orders | Observe recent cases, actual workarounds and frequency |
| A Telegram storefront is a viable first buying channel | Real buyer task completion and completed merchant orders |
| Better mobile workflow reduces merchant effort | Compare time, steps, errors and app switches on the same task |
| Exception-first operations help merchants act sooner | Measure time from exception to correct resolution |
| COD and manual Vodafone Cash are enough for an initial pilot | Completed and reconciled transactions; disputes and drop-offs |
| One-tap Ask Seller helps buyers without disrupting checkout | Contact reachability, reply latency, cart return and purchase completion |
| Merchants will continue and pay | Repeat use and an actual payment/commitment, not stated preference |
| AI shopping or order capture creates additional value | Separate controlled experiment after the basic loop works |

## Evidence rules

- Separate approved decisions, observed facts, hypotheses and proposals.
- Record date, merchant segment, consent-safe evidence, observed behavior, frequency, workaround, cost/time, counterexample and confidence.
- Do not publish conversion or time-saving claims without a measured baseline and result.
- Use desktop/browser automation for continuous development feedback. Real-device Android/PWA acceptance is tracked separately and does not block ordinary development or PR integration.
- Use synthetic data on Staging unless a merchant explicitly agrees to a limited real pilot with clear safeguards.

## First launch experiment

Run an invite-only pilot with a small number of merchants and real buyers. Measure:

- merchant invite-to-first-product and first-product publish completion;
- buyer browse/search, cart, checkout and confirmation completion;
- one order/one reservation correctness, payment reconciliation and inventory outcomes;
- merchant accept/reject, manual payment review, fulfillment and cancellation completion;
- Ask Seller reachability and cart recovery;
- notification delivery, dashboard fallback and issue rate;
- merchant repeat use and willingness to pay.

## Sequencing

1. Close the docs and baseline audit without feature work.
2. Build the first sellable product and the P0 Telegram storefront / Merchant UX Design System as a coherent vertical slice.
3. Verify the full merchant-to-buyer-to-merchant loop on permanent Staging with desktop browser/Telegram Web acceptance.
4. Keep physical Android/PWA acceptance in its dedicated deferred checklist; resume it before any claim that the installable PWA has passed on-device.
5. Promote to Production only after the owner approves a release candidate and its migration, rollback and acceptance evidence.
6. Run paid-pilot learning before implementing Growth AI, Mini App or channel expansion.

## Not a current experiment

Do not run a broad AI feature, WhatsApp integration, Mini App, subscription automation or autonomous operations in parallel with the first sellable vertical slice. Small independent engineering fixes may run in parallel only when they do not change the same schema, critical flow or Staging acceptance state.
