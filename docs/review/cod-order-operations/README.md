# COD merchant operations — phone-width evidence

These screenshots are captured by `npm run test:browser:cod-orders` against a
disposable loopback PostgreSQL database and the built Next.js application. All
store, product, order and buyer data is synthetic. No Telegram, Neon, Staging
or Production endpoint is contacted.

Viewport: **360 CSS px** (`720 px` image width at 2× device pixel ratio).

| File | Flow step |
| --- | --- |
| `01-order-placed-360.png` | A placed order shows the `Accept order` next action. |
| `02-order-accepted-360.png` | Acceptance succeeds; the next action becomes `Start preparing`. |
| `03-order-preparing-360.png` | Preparation succeeds; `Hand to shipping` is the one primary next action and cancellation remains available. |
| `04-shipping-confirm-360.png` | Handoff requires an explicit confirmation that stock will be committed and removed from on-hand. |
| `05-handed-to-shipping-360.png` | Handoff succeeds; the reservation is committed, 2 units move from 5 on-hand / 3 reserved to 3 on-hand / 1 reserved, and the next action is `Mark delivered`. |
| `06-delivered-360.png` | Delivery records its timestamp; payment stays `awaiting collection` and stock is unchanged. |
| `07-collection-confirm-360.png` | COD collection requires an explicit confirmation showing the order total. |
| `08-collected-360.png` | Collection records its timestamp and changes payment only; fulfillment and stock stay unchanged. |
| `09-collected-ar-360.png` | Arabic RTL view of the completed order at 360 px. |
| `10-cancel-reason-360.png` | A second preparing order still requires a 3–300 character cancellation reason before shipping. |
| `11-cancelled-360.png` | The second order is cancelled, the reason is visible, and its stock reservation is `released`. |
| `12-cancelled-ar-360.png` | Arabic RTL view of both the completed and cancelled orders at 360 px. |
| `13-read-only-orders-en-360.png` | Suspended-store read-only Orders view in English: orders remain readable, with no accept, prepare, shipping, delivery, collection or cancel controls. |
| `14-read-only-orders-ar-360.png` | The same read-only state in Arabic RTL at 360 px. |

The browser suite also reconciles the disposable database at each step:

- After handoff: `on_hand` is `3`, `reserved` is `1`, the reservation is
  `committed` with a commit timestamp, `handed_to_shipping_at` is set,
  `delivered_at` and `payment_collected_at` are null, and payment is still
  `awaiting_collection`.
- After delivery and collection: the order remains `delivered`, payment becomes
  `collected` with a collection timestamp, totals are unchanged, and stock
  remains `3` on-hand / `1` reserved.
- Cancellation of the second order preserves its on-hand stock, releases its
  reservation once with the submitted reason, and leaves the completed order
  and its stock untouched.
- The read-only pass suspends the store and proves orders stay readable while
  every mutation control is absent.

The PostgreSQL integration suite additionally covers invalid transitions,
repeated and concurrent shipping, cancellation racing shipping, rollback of a
failed handoff transaction, missing or released reservations, store isolation,
and read-only server-action denial.
