# Manual-Payment Journey Prototype

**Status:** synthetic prototype only. Not checkout. Not a production launch.

This document describes the channel-independent manual-payment journey introduced for
review. It exists to validate product binding, localized instructions, navigation, and the
transition from an instruction screen to the existing product-inquiry conversation.

## 1. Three separate states

| State | What it means | What it does **not** mean |
| --- | --- | --- |
| **Saved configuration** | A central `payment_method` row has a localized title/instructions and is enabled; a product `PAYMENT_METHOD` action references it by id. | It does not process a payment, create an order, or make the method visible to customers. |
| **Synthetic prototype** | When `MANUAL_PAYMENT_PROTOTYPE_ENABLED=true` on an isolated, non-production test deployment, the Telegram adapter may render eligible configured methods, show their localized instructions, label the screen as a prototype, and offer an explicit seller-contact action. | It does not transfer money, verify payment, mark anything paid, upload a receipt, or create financial state. |
| **Actual checkout** | A real, compliant payment flow with provider integration, orders, settlement, and verification. | **Not implemented.** No Telegram Stars, no gateway, no automatic verification. |

The environment capability is disabled by default. It is never set in Vercel Production.
The shared resolver and its tests do not depend on it.

## 2. Product binding

`product_action.payment_method_id` remains the only source of truth. There is no parallel
product-payment table and no copied instructions on the action row.

A product can express the journey in either supported shape:

- a root `PAYMENT_METHOD` action that opens instructions directly; or
- an `OPEN_SUBMENU` action (for example, “Purchase”) whose `PAYMENT_METHOD` children
  reference central methods.

Action order, activation, translations, ancestry, and the recursive-tree integrity rules
are unchanged. No Purchase button is inserted automatically: the acceptance fixture
configures it explicitly.

## 3. Shared resolver

`src/lib/payment-methods/journey.ts` is a server-side, channel-independent resolver. It has
no Telegram message ids, keyboards, bot usernames, or transport types. It returns:

- eligible configured `PAYMENT_METHOD` actions in stable order for a product (root or one
  `OPEN_SUBMENU` level); and
- one selected action's fresh localized title, instructions, product context, and frozen
  option-path context for the explicit contact action.

Before returning anything, it re-reads live state and verifies the product and category
hierarchy, the action's product relationship and ancestor path, action activation, the
central method's existence and activation, and customer-facing content in the requested
language or store default. It never trusts a method id supplied by a callback and never
falls back to `admin_label`.

The Telegram adapter consumes the resolver for rendering and callbacks. Dashboard previews
reuse the same pure localization helper (`src/lib/payment-methods/presentation.ts`) and are
clearly labelled as saved-content previews, not availability or payment confirmation.

## 4. Customer journey (prototype enabled)

1. The product card keeps its name, price, description, existing actions, and navigation.
2. The configured Purchase button opens its active children. Eligible methods are shown in
   configured order with localized labels, followed by Back / Return to Product / Home as
   applicable.
3. Selecting a method re-resolves fresh state and shows the product context, localized
   method title/instructions, and a prototype notice. There is no “Paid”, “verified”, or
   “I paid” control.
4. The contact button explicitly starts or resumes the existing product-inquiry journey.
   The selected method context is appended to the inquiry's frozen `selected_options`
   (for example `Purchase › Pay by bank transfer › Bank Transfer`). Viewing instructions
   alone creates no inquiry and no notification.

**Resume limitation:** inquiry deduplication and the write-once snapshot trigger are kept
intact. If an active inquiry already exists for the same customer and product, it is resumed
with its historical snapshot; the newly selected method is not written into that existing
snapshot. This preserves historical conversation context rather than rewriting it.

When no eligible method resolves, the prototype shows a localized no-methods message and
offers an existing product inquiry/support action when one is configured. Method-disabled,
deleted, inactive, cross-product, or forged references produce a localized unavailable
response with working navigation.

## 5. Capability OFF

With the capability off (the default and the deployed customer behavior):

- payment-method actions remain excluded from Telegram keyboards exactly as before;
- direct payment-method action callbacks and contact callbacks are rejected safely with
  Back/Home navigation;
- dashboard configuration, preview, central method management, and all existing
  catalog/inquiry/notification behavior remain unchanged.

## 6. Verification

- Database acceptance: `tests/db/manual-payment-journey.test.ts` runs against disposable
  PostgreSQL with mocked Telegram transport. It covers single/multiple/root/nested methods,
  language fallback, disabled/deleted/inactive/forged references, empty menus, navigation,
  no inquiry on view, contact/resume context, duplicate updates, capability OFF/ON, and
  central-edit propagation.
- Existing suites: `tests/db/payment-methods.test.ts`, `tests/db/telegram-journey.test.ts`,
  and the inquiry/notification suites continue to cover the default-off behavior.
- Browser: `npm run test:browser:payments` checks the relevant dashboard screens at 360 px
  for horizontal page overflow, binding persistence, and preview refresh.
- Headless mobile emulation is not physical Android testing. Mocked Telegram transport is
  not live-bot acceptance. No live Telegram message, production migration, secret, or
  webhook change is part of this prototype.

## 7. Explicitly not implemented

Real transfers or charges, Telegram Stars, automatic payment confirmation, receipt uploads,
paid/order/fulfillment state machines, production data writes, hosted migrations, production
capability activation, a default storefront redesign, and SaaS/multi-bot/multi-tenant
infrastructure. Other channels and SaaS remain future direction only.
