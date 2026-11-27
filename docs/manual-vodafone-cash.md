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
2. Selecting Vodafone Cash places the order, snapshots the price, shipping fee
   and the exact wallet number, recipient name and Arabic/English transfer
   instructions used at that moment, creates the stock reservation, and shows
   the **exact total** plus those snapshotted instructions. A system-owned
   guidance line tells the buyer to tap **I have transferred — submit
   reference** and then reply to the next message with the receipt reference.
   Later merchant setting changes and retries never rewrite what the buyer was
   told. The language button on the instructions keeps the order context
   (`to:<orderId>`), so EN → AR → EN returns to the same order and its
   Submit Reference button.
3. The buyer taps "I have transferred — submit reference". Each prompt request
   receives a fresh token; only the current token may bind its Telegram
   message id under the verified store, connection, buyer and chat context, so
   a delayed older send cannot replace a newer prompt.
4. The buyer replies to that prompt with the reference from the receipt.
   The claim transaction locks the order and re-checks that the replied message
   is still the current prompt for that store, connection, buyer, chat and
   order before writing. Ordinary messages, replies without a bound prompt,
   another buyer's prompt, a superseded prompt and a newer prompt for a
   different order cannot be assigned to the wrong order. Repeated replies
   after submission remain idempotent.
5. Submitting the claim moves the order to `transfer_awaiting_review` and shows
   "Awaiting merchant verification". The claim never changes payment to paid.

Buyer Home and `/start` show a **Vodafone transfers** entry when that
buyer/chat has outstanding transfer orders. It lists the order references
scoped to the verified store, bot connection, buyer and chat, and reopens the
selected order through the same state renderer and immutable snapshot. Recovery
does not depend on new-checkout availability, so it still works after the store
method or deployment switch is turned off; it is the recovery path when Home or
Cart overwrites the original instructions message.

A plain message, or a reply to the instructions message itself, is never a
claim. Only a reply to the bound ForceReply prompt can submit. The bot does not
store an instructions-message binding, so a reply to the instructions message
currently receives the ordinary scoped welcome instead of a dedicated recovery
message; adding one would require guessing the order or a schema change. The
explicit tap-and-reply guidance is shown in both Arabic and English instead.

Turning off the store method or `RABET_MANUAL_TRANSFER_ENABLED` stops **new**
Vodafone Cash checkouts. It does not block an existing `awaiting_transfer`
order from opening its prompt or submitting its reference; those operations are
authorized by the order's store, connection and buyer, not by current method
availability. Stale buttons and prompt replies render the order's actual state
(`awaiting_transfer`, submitted, verified, rejected or cancelled) instead of
starting another transfer.

Payment states used by the method:

| State | Meaning |
| --- | --- |
| `awaiting_transfer` | Order placed; buyer has not submitted a reference. |
| `transfer_awaiting_review` | Buyer claim recorded; merchant decision pending. |
| `transfer_verified` | Merchant checked the wallet and confirmed the transfer. |
| `transfer_rejected` | Merchant rejected the claim; order is cancelled. |

`transfer_awaiting_review` is also exposed as the boolean
`transferAwaitingReview` on merchant order reads and by the pure
`isTransferAwaitingReview()` helper, so the Needs Attention integration can
consume the state without importing checkout or Telegram code.

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

The **Needs Attention** section on **/app/setup** also lists buyer-reported
transfers in `transfer_awaiting_review` using the same trusted store scope. It
shows the full pending count with a bounded preview, and each row opens the
selected order in the existing review UI on `/app/orders`. A transfer leaves
that queue as soon as the merchant verifies or rejects it, or cancels the order.
The separate COD acceptance queue keeps its existing behaviour.

## Reservation lifecycle

- **Held:** order placement for either COD or Vodafone Cash increments
  `product_inventory.reserved` and creates one `inventory_reservation` row with
  status `reserved`. A cart never reserves stock. An abandoned
  `awaiting_transfer` order keeps this hold until the merchant cancels it.
- **Unchanged by claim or verification:** submitting or approving a claim does
  not touch inventory. The hold remains until shipping or cancellation.
- **Released:** merchant cancellation or claim rejection sets the reservation
  to `released`, decrements `reserved` exactly once and leaves `on_hand`
  untouched because nothing shipped.
- **Committed:** handoff to shipping sets the reservation to `committed` and
  decrements both `on_hand` and `reserved` exactly once. A Vodafone Cash order
  cannot be handed to shipping before `transfer_verified`; COD keeps its
  existing handoff-before-collection rule.

## Abandoned awaiting_transfer orders

If a buyer places a Vodafone Cash order and never reports a transfer, the order
stays `awaiting_transfer` and its reservation remains held. The merchant sees
that state and the "waiting for the buyer to submit a transfer reference" note
on `/app/orders`. The merchant resolves it with the existing **Cancel order**
action before shipping: this writes a cancellation reason, releases the held
reservation exactly once, closes any pending claim as cancelled, and leaves
`on_hand` untouched. There is deliberately no automatic expiry, automatic
cancellation, refund or provider reconciliation in this PR.

## Deliberately outside this PR

- Real bank/provider transfer verification or automation.
- Telegram buyer/merchant notifications for transfers.
- Staging and Production changes.

## Tests

- `tests/db/manual-vodafone-cash.test.ts` covers configuration and store
  isolation, disabled method behavior, buyer claim idempotency, approval,
  rejection, repeated and competing decisions, inventory effects, reference
  reuse, shipping commitment and COD regression.
- Existing COD database, Telegram journey and browser suites remain the COD
  regression gate.
