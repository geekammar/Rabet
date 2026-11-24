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
| `03-order-preparing-360.png` | Preparation succeeds; cancellation remains available before shipping. |
| `04-order-cancel-reason-360.png` | Cancellation form requires a 3–300 character reason. |
| `05-order-cancelled-360.png` | Order is cancelled, the reason is visible, and the stock pill is `released`. |
| `06-order-cancelled-ar-360.png` | Arabic RTL view of the same cancelled order at 360 px. |
| `07-read-only-orders-en-360.png` | Suspended-store read-only Orders view in English: orders remain readable, no mutation controls. |
| `08-read-only-orders-ar-360.png` | The same read-only state in Arabic RTL at 360 px. |

The browser suite also queries the disposable database after cancellation:
`on_hand` is unchanged, `reserved` returns to `0`, and the single reservation
is `released` with the submitted reason and a release timestamp. It then seeds
a second placed order and suspends the store to prove that a read-only merchant
still sees orders while Accept, Prepare and Cancel controls are absent.
