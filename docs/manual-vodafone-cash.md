# Manual Vodafone Cash transfers (pilot)

This slice adds a second payment method to the existing managed-store order
lifecycle. It is intentionally manual: a buyer reports a transfer, and the
merchant checks their own wallet before recording a decision in Nokmel. No
provider API, webhook, automatic reconciliation or Telegram notification is
part of this PR.

## Enablement

Both layers must be on before checkout offers the method:

1. Deployment: `RABET_MANUAL_TRANSFER_ENABLED=true`.
2. Store: `store_commerce_setting.vodafone_cash_enabled = true` plus a wallet
   number, recipient name and at least one language of instructions.

The merchant configures these on **/app/setup** in the "Vodafone Cash — manual
transfer" card. The save action uses the verified merchant store scope, blocks
read-only stores, and re-checks eligibility inside the transaction. COD has its
own independent switch and continues to work unchanged.

## Buyer flow

1. Checkout review shows COD exactly as before and adds a Vodafone Cash button
   only when the method is enabled and configured.
2. Selecting Vodafone Cash places the order, snapshots the price and shipping
   fee, creates the stock reservation, and shows the **exact total**, wallet
   number, recipient name and localized transfer instructions.
3. The buyer taps "I have transferred — submit reference" and sends the
   reference from the receipt as text.
4. Submitting the claim moves the order to `transfer_awaiting_review` and shows
   "Awaiting merchant verification". The claim never changes payment to paid.
   A repeated submission with an existing claim is idempotent.

Payment states used by the method:

| State | Meaning |
| --- | --- |
| `awaiting_transfer` | Order placed; buyer has not submitted a reference. |
| `transfer_awaiting_review` | Buyer claim recorded; merchant decision pending. |
| `transfer_verified` | Merchant checked the wallet and confirmed the transfer. |
| `transfer_rejected` | Merchant rejected the claim; order is cancelled. |

`transfer_awaiting_review` is also exposed as the boolean
`transferAwaitingReview` on merchant order reads and by the pure
`isTransferAwaitingReview()` helper, so a future Needs Attention integration
can consume the state without importing checkout or Telegram code.

## Merchant flow

The existing **/app/orders** page shows the buyer reference for a pending claim
with the reported time, amount and merchant decision controls:

- **Verify transfer** records `decided_by` (the authenticated merchant user)
  and `decided_at`, then sets the order to `transfer_verified`.
- **Reject transfer** records the same actor/time with an optional note,
  releases the reservation and cancels the order in one transaction.

Both actions lock the order row first. Retries return `already_applied`; two
competing decisions serialize so exactly one payment decision and at most one
stock effect are recorded. Read-only merchant access and all cross-store order
ids are rejected at the existing authorization boundary.

## Reservation lifecycle

- **Held:** order placement for either COD or Vodafone Cash increments
  `product_inventory.reserved` and creates one `inventory_reservation` row with
  status `reserved`. A cart never reserves stock.
- **Unchanged by claim or verification:** submitting or approving a claim does
  not touch inventory. The hold remains until shipping or cancellation.
- **Released:** merchant cancellation or claim rejection sets the reservation
  to `released`, decrements `reserved` exactly once and leaves `on_hand`
  untouched because nothing shipped.
- **Committed:** handoff to shipping sets the reservation to `committed` and
  decrements both `on_hand` and `reserved` exactly once. A Vodafone Cash order
  cannot be handed to shipping before `transfer_verified`; COD keeps its
  existing handoff-before-collection rule.

## Deliberately outside this PR

- Real bank/provider transfer verification or automation.
- Telegram buyer/merchant notifications for transfers.
- Needs Attention UI from draft #61. This PR only exposes the stable state.
- Staging and Production changes.

## Tests

- `tests/db/manual-vodafone-cash.test.ts` covers configuration and store
  isolation, disabled method behavior, buyer claim idempotency, approval,
  rejection, repeated and competing decisions, inventory effects, reference
  reuse, shipping commitment and COD regression.
- Existing COD database, Telegram journey and browser suites remain the COD
  regression gate.
