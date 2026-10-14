# Architecture — Rabet (رابط)

This document records the chosen stack, the structure of the codebase and the
architectural decisions behind them. It is updated as phases are delivered.

Related: [PROGRESS.md](./PROGRESS.md) for phase status.

---

## 1. Overview

Rabet is a **modular monolith**: one deployable Next.js application that serves
both the public landing page and the admin dashboard, and that will later host
the Telegram webhook endpoints in the same codebase.

```
                    ┌─────────────────────────────────────────┐
                    │            Vercel (Next.js)             │
   Telegram  ───────┤  webhooks  ────────┐                    │
     users          │                    ▼                    │
                    │            grammY bot layer   ──────────┤
                    │                    │          writes    │
                    │                    ▼                    │
                    │            PostgreSQL on Neon           │
                    │            (Drizzle ORM)               │
                    │                    │                    │
   Admin  ──────────┤  dashboard ────────┘  reads             │
   (browser)        └─────────────────────────────────────────┘
```

The system has one admin and one Telegram bot. Customers interact only with the
bot; the merchant interacts only with the dashboard.

> **Product scope (Phase 03A, corrected).** Rabet is a **configurable digital-product
> catalog inside a Telegram bot with a mobile-first admin dashboard**. Customers browse an
> arbitrarily deep catalog, interact with **configurable recursive button trees** per
> product, and **open inquiries** — tracked conversations with the seller. The MVP does
> **not** handle payments: no checkout, no payment gateway, no order and no invoice. An
> inquiry is a conversation, not a purchase. See ADR-013 and
> [DATA_MODEL.md](./DATA_MODEL.md).

## 2. Tech stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js 16 (App Router) | One app for pages, API routes and bot webhooks |
| Language | TypeScript (strict) | `strict: true`, `@/*` → `./src/*` |
| UI | React 19 + Tailwind CSS v4 | Design tokens as CSS variables |
| Components | shadcn/ui (radix-nova) + lucide-react | Components are copied into the repo, not a dependency |
| Validation | Zod | Installed in Phase 02 — sign-in input validation at the trust boundary |
| Testing | Vitest | Installed in Phase 02 — unit + auth integration suites |
| ORM | Drizzle | Implemented in Phase 03B — schema in `src/db/schema`, migrations in `drizzle/` ([DATA_MODEL.md](./DATA_MODEL.md)) |
| Database | PostgreSQL on Neon | Implemented in Phase 03B — `drizzle-orm/neon-http` client (ADR-015); no production database provisioned yet |
| Auth | Auth.js v5 (`next-auth@5.0.0-beta.32`) | Installed in Phase 02 — one admin, Credentials provider, encrypted JWT sessions |
| Password hashing | `@node-rs/argon2` | Installed in Phase 02 — Argon2id, OWASP-recommended parameters |
| Telegram | grammY | Planned — bot framework and webhooks |
| Hosting | Vercel | Base project configured in Phase 01; previews and production via the GitHub integration |

**Phase 01 installed the framework and UI rows plus the base Vercel hosting
project; Phase 02 added validation, testing, authentication and password
hashing; Phase 03B implemented the ORM, the database client and the migration
chain.** Remaining future dependencies are intentionally absent so that
no dead code or half-wired modules exist before their phase begins.

### 3.1 Database layer structure (Phase 03B)

```
src/db/
├── client.ts        # `getDb()` — lazy, server-only neon-http Drizzle client
└── schema/          # One module per domain, barrel-re-exported by index.ts
    ├── settings.ts  # bot_setting (singleton), language
    ├── content.ts   # message_template, message_translation
    ├── catalog.ts   # category (Tree 1), category_translation, product, product_translation
    ├── actions.ts   # product_action (Tree 2), product_action_translation, action_type enum
    ├── customer.ts  # customer
    ├── inquiry.ts   # inquiry, inquiry_message + their enums
    ├── telegram.ts  # telegram_update (deduplication log)
    └── index.ts     # barrel — import this, never an individual module

drizzle/             # Generated, human-reviewed SQL — the committed source of truth
├── 0000_initial_schema.sql               # 14 tables, 4 enums, 19 FKs, all indexes
├── 0001_tree_and_snapshot_integrity.sql  # triggers: ancestry, menu capability, write-once snapshots
└── meta/                                 # Drizzle journal + snapshots
```

The client imports `server-only`, so neither it nor any database credential can
reach a browser bundle. It is created lazily through `getDb()`, so importing the
module never requires `DATABASE_URL` — a production build and every current
route work without a database configured, and the first real query fails loudly
with a credential-free message instead (ADR-015).

### 3.2 Data access layer structure (Phase 03C-A)

```
src/lib/data/
├── errors.ts        # RabetDataError + SQLSTATE mapping + safe message funnel
├── languages.ts     # language registry, enable/disable, default resolution
├── settings.ts      # bot_setting singleton — read / initialize / update
├── templates.ts     # message templates, translations, fallback resolution
└── index.ts         # the barrel — the public surface; imports `server-only`
```

The layer between the schema and the application. Four of the fourteen tables are
covered (`bot_setting`, `language`, `message_template`, `message_translation`);
the catalog, button, customer and conversation tables get their own layers in
Phases 05–09.

The rules the layer keeps, and which make it safe to build UI on:

- **Server-only by construction.** Every module imports `server-only`, so no
  data-access code and no database credential can reach a client bundle (verified
  by a scan of `.next/static` after a production build). A Client Component must
  never import `@/lib/data`.
- **One injected client.** Every function takes the Drizzle client as its first
  argument — `readSettings(getDb())` in production, a real PostgreSQL client in
  the integration tests. There is no module-level client creation and no
  module-level query, so importing the barrel never requires `DATABASE_URL`
  (ADR-015) and no dashboard route queries the database by merely rendering.
- **No generic repository framework.** Each function is one query with a
  documented purpose; what is shared is the error vocabulary and the validation
  schemas, not plumbing.
- **Typed errors with safe messages.** Every failure is a `RabetDataError`
  carrying a stable `DataErrorCode`. `mapDatabaseError()` converts a raw driver
  error by SQLSTATE class — walking Drizzle's `DrizzleQueryError` wrapper to the
  driver error, whose own message carries the failed SQL and parameters — and
  `toSafeErrorMessage()` collapses anything unknown into one fixed sentence that
  can hold no credential, identifier or SQL.
- **Atomicity without interactive transactions.** Every write is a single
  statement idempotent at its own site (`ON CONFLICT DO NOTHING` / `DO UPDATE`),
  which is exactly the shape ADR-015 calls for. No Phase 03C-A path needs
  `db.batch([...])`; the first write path that genuinely requires several
  statements to commit together will use it, and never `db.transaction()`.

**The authorization boundary.** The layer performs no authorization check itself,
and this is deliberate: Rabet has exactly one administrator and one trust
decision, which belongs at the call site. **Every Admin Server Action and Route
Handler that calls into `src/lib/data/` must call `requireAdmin()**
(`src/lib/auth/session.ts`) at its entry boundary** (ADR-010). The layer's
`index.ts` records the rule where a new caller will read it. This phase exposes
no unauthenticated database-writing endpoint and adds no route.

**The initialization contract.** No business data is seeded. The `bot_setting`
singleton comes into existence through one explicit, idempotent flow —
`ensureLanguage` for the default language, then `initializeSettings` with the
owner's explicit values — and re-running any step is a safe no-op. The full
contract is documented in [PROGRESS.md](./PROGRESS.md), "The initialization
contract".

## 3. Codebase structure

The App Router is the structural backbone. Colocation keeps related files
together; there is no separate `packages/` workspace because a single
deployable is simpler to build, test and deploy at this scale.

### Route groups

```
src/app/
├── page.tsx              # Landing page (public)
├── manifest.ts           # Web App Manifest → /manifest.webmanifest (PWA)
├── favicon.ico           # Brand favicon, generated from the brand mark
├── (dashboard)/          # Route group — no URL prefix
│   ├── overview/         # /overview
│   ├── catalog/          # /catalog
│   ├── inquiries/        # /inquiries
│   ├── customers/        # /customers
│   ├── bot-content/      # /bot-content
│   ├── telegram/         # /telegram
│   └── settings/         # /settings
```

The dashboard lives in a **route group** so that:

- Dashboard URLs stay short (`/overview`, not `/dashboard/overview`).
- The dashboard shell (sidebar + header) is defined once in the group layout.
- A boundary exists for Phase 2 to attach authentication without touching the
  public landing page.

> **Re-scoped routes.** The Phase 01 placeholders `/orders`, `/payments` and
> `/services` were removed when the shell was aligned with the catalog +
> inquiries MVP (ADR-013); the sections above are the ones the data model
> actually serves. `/catalog` is where the catalog and the Button Tree Editor
> will live in Phase 05.

### Component layout

```
src/components/
├── brand/         # Logo
├── dashboard/     # Shell pieces: sidebar, header, mobile nav, shared nav
├── ui/            # shadcn/ui primitives (button, card, badge, sheet, …)
├── empty-state.tsx
└── page-header.tsx

public/icons/      # PWA icons served as-is (any + maskable + apple touch)
scripts/           # generate-pwa-icons.py (icons), generate-admin-hash.mjs (Argon2id
                   # provisioning), db-test-postgres.mjs (disposable DB test cluster)
drizzle/           # Generated, reviewed SQL migrations (Phase 03B)
```

### Mobile-first shell

The merchant works from a mobile device, so the shell is built mobile-first and
reviewed at 320, 360, 390, 430, 768, 1024 px and desktop:

- The sidebar collapses to a Radix `Sheet` drawer below `md`; both surfaces
  render the same `DashboardNav`, and drawer navigation is single-handed
  (opens from the header, closes on tap, `Escape` or overlay).
- All navigation items and primary controls are at least 44 × 44 CSS px.
- The root layout uses `min-h-dvh` against the mobile dynamic viewport, and
  `viewport-fit=cover` plus `env(safe-area-inset-*)` padding keeps the sticky
  header, sidebar, drawer and page bottoms clear of notches and the home
  indicator in standalone mode.
- Content is width-constrained (`min-w-0` on the flex column, `max-w-6xl`
  content rail, mobile-first single-column grids) so the layout cannot overflow
  horizontally.

### Server Components first

Pages, layouts and shell components are Server Components. Client Components are
used only where interactivity requires them:

- `dashboard-nav.tsx` — needs `usePathname` to mark the active link.
- `mobile-nav.tsx` — needs local state to open/close the drawer.
- `ui/sheet.tsx`, `ui/separator.tsx` — Radix primitives.
- `error.tsx` — error boundaries must be Client Components.

### Single source of truth for navigation

`src/lib/navigation.ts` exports the navigation list once. The desktop sidebar,
the mobile drawer and the overview quick-links all consume it, so the three
views can never drift apart. Adding a section is a one-file change.

## 4. Architectural decisions

### ADR-001 — Modular monolith over microservices

**Decision.** Build one Next.js application with clearly separated modules
instead of separate bot, API and dashboard services.

**Rationale.** There is one admin and one bot. A monolith removes network hops,
shared-schema synchronisation and multi-repo operational overhead, while module
boundaries keep the code organised. If scale ever demands it, modules can be
extracted later.

### ADR-002 — shadcn/ui instead of a component library

**Decision.** Use shadcn/ui (Radix-based primitives copied into `src/components/ui`)
rather than installing a large third-party component library.

**Rationale.** The components ship as source, so they are fully auditable,
themeable through design tokens and removable. We pull in only what the UI needs
(button, card, badge, skeleton, separator, sheet) instead of a dependency
containing hundreds of unused components. Accessibility (focus management, ARIA)
comes from the underlying Radix primitives.

### ADR-003 — Design tokens as CSS variables

**Decision.** Express colour, radius and font as CSS variables consumed by
Tailwind v4's `@theme inline`.

**Rationale.** Semantic token names (`bg-background`, `text-muted-foreground`,
`border-border`) keep markup readable, guarantee consistent colour usage and make
a future dark theme a token swap rather than a rewrite. Light and dark token
sets are already defined in `globals.css`.

### ADR-004 — Separate payment and fulfillment statuses

> **Status note (Phase 03A):** this decision describes the **deferred** future checkout
> feature. The MVP has no orders and no payments (ADR-013), so neither status exists in the
> current data model. The decision is retained because it records the shape real checkout
> work must take when it is explicitly scheduled.

**Decision.** An order will carry two independent statuses: a **payment status**
and a **fulfillment status**.

**Rationale.** Payment and delivery of a digital service are distinct lifecycles.
A service can be paid but not yet delivered, or delivered while payment is being
confirmed. Collapsing them into a single state forces ambiguous values such as
"completed" and makes reporting unreliable. The two statuses are introduced by
the schema work in a future checkout phase and exercised by the order work that
follows it.

### ADR-005 — Telegram Stars first; payment providers stay modular

> **Status note (Phase 03A):** no payment integration is in scope for the MVP or for the
> Phase 03A data model — there is no order, payment or checkout entity. The compliance
> guardrail below is now recorded more precisely as **ADR-013**, which governs how the
> bot's `OPEN_URL` action may and may not be used.

**Decision.** Digital goods and services sold inside the bot are paid with
Telegram Stars. No real payment integration is active yet — the project is in
Discovery & Development.

**Rationale.** Telegram's terms require Stars for digital goods sold inside
bots, so Stars are the default and the first choice. The earlier stance that no
other provider would ever be integrated was too absolute. Binance **personal
payment links** are being evaluated, but only for separately permitted contexts,
and they are not being integrated now. Personal payment links can expire, so
they must never be assumed valid indefinitely. No external checkout capability
is being invented or promised.

**Consequences.** Payment-specific code will stay behind a small modular
boundary so a provider can be added or replaced without reworking order flows,
and payment and fulfillment statuses remain separate in the data model
(see ADR-004). No payment code exists, and none is scheduled for the MVP.

### ADR-006 — English first, Arabic optional

**Decision.** English is the default bot language. Arabic is an optional,
explicitly enabled language.

**Rationale.** Defaulting to one language keeps content and UX predictable, and
content strings will be externalised in Phase 04 (settings & localization) so
that Arabic can be added without restructuring. The dashboard interface itself
is English only.

### ADR-007 — No database, auth or bot code in Phase 01

**Decision.** Phase 01 contains only the UI shell, routes, documentation and CI.
No ORM, auth, webhook or payment code is included.

**Rationale.** Authentication protects every business endpoint, and the schema
shapes every data structure. Building them later, in one coherent pass, avoids
placeholder schema rework and avoids a dashboard that looks functional but is
not. Application-level authentication arrives in Phase 02; until then the
dashboard is explicitly marked as a non-secure preview and must not be described
as secure.

### ADR-008 — PWA foundation is manifest-only; no service worker yet

**Decision.** Phase 01C makes the dashboard installable through a Web App
Manifest (`src/app/manifest.ts`), real brand icons, theme color, standalone
display mode and Apple touch metadata. It deliberately does **not** introduce a
service worker, offline caching, Web Push Notifications, or a custom install
button.

**Rationale.** Rabet is an admin application. A service worker that caches
dashboard HTML, API responses or any authenticated payload would risk serving
stale or private business data (customer records, orders, payments) from a
device, and a stale cached shell can mask the fact that a user is signed out.
There is no proven offline requirement: every administrative action in the
product roadmap needs the network anyway. The manifest-only approach delivers
the real user benefit of this phase — a home-screen icon and a standalone,
app-like window — without that risk surface. Installation is left to the
browser's own prompt, so no fake install affordances exist.

**Consequences.** The installed app requires a network connection. When a
genuine offline requirement is identified and Phase 02 authentication exists, a
service worker can be added behind an explicit cache-strategy review, caching
only the static shell and never authenticated or data responses. Web Push is
not part of any planned merchant flow and stays out until there is a concrete
need.

### ADR-009 — Database-free JWT sessions, and their revocation limitation

**Decision.** Phase 02 uses Auth.js v5 (`next-auth@5.0.0-beta.32`) with the
Credentials provider and the default **stateless encrypted JWT** session
strategy — no adapter, no database. The single administrator is declared by the
`ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` environment variables; the password hash
is an Argon2id PHC string verified with `@node-rs/argon2`. The session is an
encrypted, `HttpOnly`, `Secure`-under-HTTPS, `SameSite=lax` cookie named
`__Secure-authjs.session-token`, encrypted with `AUTH_SECRET`, with a 7-day
`maxAge`.

**Rationale.** The MVP has exactly one administrator and no database yet, so a
session table would require infrastructure that Phase 03 introduces anyway.
Auth.js's encrypted-cookie JWT needs no datastore and is the documented,
library-maintained path — no custom JWT or crypto code is written. Argon2id is
the OWASP-recommended memory-hard hash; plain SHA-256 is never used for
passwords. Missing or invalid configuration fails closed (`getAdminConfig()`
returns `null` and every sign-in is rejected), so there is no default account
and no bypass.

**Consequences — the important limitation.** Because the session is a
self-contained encrypted token and not a server-side record, **logout clears the
browser cookie but does not revoke a token that has already left the device.**
A stolen cookie remains valid until its natural 7-day expiry; there is no
server-side denylist to invalidate it sooner. Mitigations in place: the short
`maxAge`, `Secure` + `HttpOnly` + `SameSite=lax` cookie attributes, `private,
no-store` cache headers on every dashboard route, and a generic
invalid-credentials error that leaks no signal about the admin identity.
Central revocation (a session table or rotated `AUTH_SECRET`) is a deliberate
Phase 03+ decision once a database exists; rotating `AUTH_SECRET` invalidates
all outstanding sessions immediately, at the cost of signing everyone out.

### ADR-010 — Authorization is layered; `proxy.ts` is not the sole gate

**Decision.** Every dashboard route is protected at **two** independent layers:

1. `src/proxy.ts` (the Next.js 16 rename of `middleware.ts`) runs an *optimistic*
   Auth.js check and redirects an unauthenticated visitor to `/login` before the
   dashboard shell is ever downloaded.
2. `requireAdmin()` (`src/lib/auth/session.ts`) is the *authoritative*
   server-side check, called by the `(dashboard)` layout, by Server Actions
   (`src/app/actions/auth.ts`) and by Route Handlers (`src/app/api/admin/route.ts`).

**Rationale.** A Next.js layout does not re-run on every navigation, and
returning `null` from a layout does not stop nested segments or Server Actions
from executing. Equally, the proxy matcher excludes paths (the Auth.js route
handler, static and PWA assets), and excluding a path also skips Server Function
invocations on it — so the proxy cannot be the only gate. Centralizing the
authoritative check in one `server-only` helper means a new route is protected
by calling a single function, and a handler that forgets it is the only gap.

**Consequences.** Both layers read the session cookie; `getAdminSession()` is
wrapped in React `cache()` so a render pass reads it once. Protected responses
are marked `private, no-store, must-revalidate` statically in `next.config.ts`
(declared statically because, with Cache Components, the dashboard shell's
headers are finalized before the streamed gated segment runs, so an imperatively
set header at request time throws). Redirect destinations after login are
validated against an internal allowlist (`isValidInternalRedirect`) so the login
page cannot become an open redirect.

### ADR-011 — No application rate limiting in Phase 02; what limits brute force instead

**Decision.** Phase 02 deliberately ships **no application-level rate limiter** on
the sign-in endpoint. This is a documented gap, not an omission, and it is
recorded here so it is not mistaken for a control that exists.

**Rationale.** The deployment target is Vercel serverless functions. An in-process
counter (a `Map` of attempt counts, or a token-bucket variable) is **not reliable**
there: each invocation may run in a fresh instance with its own memory, so a
counter in one instance does not constrain a request that lands on another. Such a
limiter would both under-count an attacker who fans out across instances and
over-count a legitimate admin whose requests are spread across them. Presenting it
as protection would be misleading, so it is not implemented and no claim is made
that it is.

What does limit brute force today:

- **Argon2id is memory-hard.** Every sign-in attempt costs 19 MiB of memory and
  roughly 20–25 ms of CPU on this VPS, and the cost is paid on *every* attempt —
  including when the email does not match, so the expensive work cannot be
  skipped to detect a correct address. Guessing a strong password at that cost,
  serially or across a bounded number of concurrent function instances, is
  impractical for the credential sizes involved.
- **Exactly one identity.** There is a single admin declared by environment
  variables, no registration, and no user list, so there is no account to
  enumerate and no password-spray target surface beyond one account.
- **A generic, uniform failure response.** Every failure mode returns the same
  "Incorrect email or password." message and the same timing profile, so the
  endpoint leaks no signal about which part of the credential was wrong.
- **Vercel Deployment Protection stays enabled**, so the preview and production
  endpoints are not reachable from the open internet by default.

**Recommendation before public access (smallest suitable protections).** In rough
order of effort, any *one* of these closes the gap properly:

1. **Vercel's platform-level protections** — the built-in DDoS mitigation plus a
   Firewall rate-limit rule scoped to `POST /api/auth/callback/credentials` and
   the `/login` page. This is configured in the Vercel dashboard, requires no code
   and no new dependency, and is enforced at the edge before a function is ever
   invoked — which is exactly where a serverless application cannot enforce it
   itself.
2. **A durable, external limiter** such as Upstash Ratelimit (REST-based, designed
   for serverless, free tier) or Vercel KV applied to the same two endpoints. This
   is the application-level equivalent of option 1 and shares state across
   instances because the state lives outside them.

Both are deliberately deferred out of Phase 02 because they require provisioning an
external resource and a secret, which is an operations decision for the owner, not
a code change. **Until one of them is in place the application should not be
treated as brute-force hardened for an internet-facing deployment**, and Vercel
Deployment Protection should remain on.

**Consequences.** The gap is time-bounded: Phase 03 introduces a database, at which
point a durable counter becomes a local concern rather than an external service and
can be revisited alongside session revocation (ADR-009).

### ADR-012 — Phase 03A data model is designed, not implemented

**Decision.** Phase 03A produces a reviewed **design only** — the entity model, integrity
rules, infrastructure recommendation and migration plan in
[docs/DATA_MODEL.md](./DATA_MODEL.md). It deliberately creates **no** `src/db/` code, **no**
Drizzle schema, **no** SQL migration files, **no** new dependency, and **no** database or
Neon account. Nothing is applied to any database.

**Rationale.** The schema touches every later phase (settings, services, orders, payments,
support). Freezing it as a reviewed document before any migration is generated means the
first `0000_initial.sql` is born coherent instead of being rewritten as each phase
discovers the previous one's mistakes. It also keeps the mandate's hard rules structural:
no production migration runs from a Vercel build or app startup, `drizzle-kit push` is
never used, and no destructive migration is accepted — all documented in §11 of that
document.

**Consequences.** Phase 03B has an explicit, ordered list of prerequisites (§17 of
that document), including product sign-off on a small set of open decisions. The model
targets the one-admin, one-bot MVP: it contains no multi-tenancy, multi-bot, role or
analytics structure.

> **Revision (same phase, later clarification).** The Phase 03A model was subsequently
> simplified per product-owner review: the financial subsystem (orders, payments, events)
> was removed entirely and replaced by a **catalog + configurable recursive button tree +
> inquiry** model. See **ADR-013** and **ADR-014** below, and
> [DATA_MODEL.md](./DATA_MODEL.md). The design-only rule above is unchanged.
>
> **Status (Phase 03B).** The approved design has since been **implemented** — Drizzle
> schema in `src/db/schema`, two reviewed SQL migrations in `drizzle/`, the server-only
> `neon-http` client in `src/db/client.ts`, and a 53-test PostgreSQL integration suite in
> `tests/db`. Still **no** production database has been created or contacted, and no
> migration has run anywhere but a disposable cluster. See
> [PHASE_03B_HANDOFF.md](./PHASE_03B_HANDOFF.md).

### ADR-013 — Rabet is a catalog with inquiries, not a checkout (Phase 03A scope correction)

**Decision.** The Rabet MVP is a **digital-product catalog inside a Telegram bot** with
**displayed prices** and **seller inquiries**. Selecting a product and starting a
conversation creates an **inquiry** — a tracked customer ↔ seller thread — and **never**
creates an order, a payment, an invoice or a charge. There is no payment gateway, no
Binance API, no Vodafone Cash API, no financial webhooks, no payment-evidence processing,
no settlement engine, no invoices and no refunds anywhere in the design. This supersedes
the earlier Phase 03A drafts that centred on orders and payments.

**Rationale.** The product owner's clarifications converged on one target: a customer
browses the catalog, interacts with configurable buttons, and **contacts the seller**;
the seller replies from the dashboard. The primary action is a conversation, not a
transaction. Keeping a fourteen-table financial model around that structure would have
meant maintaining order, order-item, order-event and payment tables plus an append-only
audit log — all in service of a checkout nobody can use yet.

**The compliance guardrail that makes this a decision rather than a deferment.** Rabet
offers **digital services**. Telegram's official Bot Payments terms require **Telegram
Stars exclusively for the sale of digital goods and services inside bots and Mini Apps,
including where an external payment page exists** — so routing an in-bot digital purchase
to a seller-owned payment link does not by itself make it permitted. Therefore:

- `OPEN_URL` exists for **information pages only**. It must never be framed, configured or
  used as a payment or checkout redirect, or as a substitute for compliant Stars checkout.
- The MVP has **no real digital payment initiated by the bot**, and no proof/claim
  workflow that could masquerade as one.
- A future real in-bot sale must be built on compliant Telegram Stars checkout, or the
  commerce must genuinely live outside the bot's checkout/referral flow.

Sources: <https://core.telegram.org/bots/payments-stars> and
<https://telegram.org/tos/bot-developers> §6.2.

**Consequences.** A displayed price is a **quote**, not a charge — so the price a customer
saw is frozen onto the inquiry at creation time (immutable `product_snapshot`), which is
the only snapshot discipline the MVP needs. Orders and payments remain **deferred with a
designed additive path**, not deleted and not started. `ADR-004` and `ADR-005` now describe
that deferred future rather than the current model.

### ADR-014 — Two independent recursive hierarchies, both adjacency lists

**Decision.** The data model contains **two separate recursive structures that are never
merged**:

1. **The catalog hierarchy** (`category`, self-referencing `parent_id`) — organizes
   products. Categories are pure navigation; products carry prices and button trees.
2. **The interaction hierarchy** (`product_action`, self-referencing `parent_action_id`)
   — controls customer interaction. Each product owns a tree of configurable buttons;
   every button independently has a type, a localized label, an order, an activation state
   and optionally children.

Both are **adjacency lists**. Neither carries a depth column or a depth constraint;
arbitrary depth is bounded only by documented application-level runtime guards — the nesting
is **unlimited in the schema**, while the editor and renderer apply adjustable operational
safeguards (DATA_MODEL.md §11.3). Moving
between the two trees is an explicit, validated action (`NAVIGATE_CATALOG`) with real
foreign-key targets, never an implicit structural link. Telegram navigation within the
interaction tree uses **self-scoping callback tokens** (`b:` / `m:` / `p:` prefixed ids) so
Back, Return-to-product and pagination are unambiguous with several products or old messages
open, with no server-side session state (DATA_MODEL.md §8.1).

**Rationale.** Catalog navigation and interaction-button navigation are different
operations with different integrity rules: a category groups products, while a button
executes an action or opens a submenu. Merging them (or forcing navigation actions into
the category table) would produce one structure that serves two masters, with neither
invariant enforceable — a category cannot "start an inquiry" and a button cannot "contain
products". Separating them makes each one's constraints expressible in the database:
same-product containment, menu-capable-only parents, sibling-order uniqueness and
cycle prevention are all triggers and indexes on a table with one clear purpose.

The **adjacency list** is chosen over a materialised path, `ltree` or a graph store
because at this scale it is the simplest correct structure — one table per tree, nothing
denormalized to keep in sync, native recursive-CTE traversal — and because the scale-up
path (add a path/`ltree` column maintained by trigger) is purely additive.

**Consequences.** Two trees means two sets of integrity triggers and two sets of sibling
indexes, but each set is small and identical in shape, so there is one mental model. A
button's ancestor chain doubles as **the customer's selected path** when an inquiry starts,
which removes the need for any cart or selection state. Adding nesting levels and supported
button types is configuration, not code.

### ADR-015 — Atomic writes use `db.batch()`, not interactive transactions (neon-http)

**Decision.** Phase 03B's data layer uses `drizzle-orm/neon-http` over Neon's pooled HTTP
endpoint, and every atomic multi-step write is expressed as **`db.batch([...])`** — a
non-interactive batched transaction — **not** as an interactive `db.transaction(async (tx) =>
{ … })` callback. `drizzle-orm/neon-serverless` (WebSocket `Pool`) is the documented escape
hatch for a future path that genuinely needs interactivity, and is not installed by default.

**Rationale.** Verified against the Drizzle driver source and current Neon documentation
(October 2026): on `neon-http`, `NeonHttpSession.transaction()` literally throws
`No transactions support in neon-http driver`. The interactive callback form — read, branch,
conditionally write inside one server-side transaction — is simply unavailable on the fastest,
cheapest driver for Vercel serverless. Rather than discover this during implementation, the
design's write paths are shaped to not need it:

1. validation reads run as plain queries *before* any write, with branching in Node;
2. every state-changing write is **idempotent at its own site** (`ON CONFLICT DO NOTHING`
   against `telegram_update.update_id`, `UNIQUE (inquiry_id, telegram_message_id)`, and the
   active-inquiry partial unique index), so a repeated statement is a no-op;
3. one `db.batch([...])` per unit of work gives all-or-nothing atomicity — a failure rolls the
   whole batch back, including the dedup row;
4. external side effects (Telegram sends) happen *after* the batch commits, with the
   `inquiry_message` row as the durable record and `pending → sent | failed` tracking the
   outcome — a crash between commit and send leaves exactly one retryable `pending` row.

**Consequences.** The idempotency design (the one-row-lock pattern) carries the correctness
load, which is where it belongs anyway — it is what protects against double-taps and
redelivered webhooks independent of the driver. No WebSocket dependency, no per-request
connection lifecycle, one round trip per unit of work. The constraint this imposes is honest
and small: no path may read a row it just wrote in order to decide what to write next. See
DATA_MODEL.md §15.3.

## 5. Data flow (future)

1. A customer starts the bot; the customer row is created and, if more than one language is
   enabled, the customer chooses a language.
2. grammY receives updates via a Vercel webhook; every update is deduplicated before any
   business logic runs.
3. The customer browses the recursive category catalog and opens a product, which renders
   its configured root buttons.
4. The customer navigates the product's recursive button tree; each tap resolves a
   self-scoping callback token server-side, validates it, and either opens a submenu, shows
   details, sends a localized template, opens an information URL, navigates the catalog, or
   starts an inquiry.
5. An inquiry freezes the product context and the customer's selected path, and becomes a
   two-way conversation; the admin replies from the dashboard and the bot relays replies.
6. Drizzle validates every write; Zod validates every external input.

## 6. Testing strategy

- **Vitest** is installed and running (Phase 02).
  - Unit tests under `src/**/__tests__/` cover the auth modules: fail-closed
    admin configuration, credential verification, and the redirect allowlist.
  - `tests/auth.test.ts` is an integration suite driven over HTTP against the
    real production server (`next start`) with a synthetic, throwaway
    configuration. The listen ports are configurable via `RABET_TEST_PORT` and
    `RABET_TEST_PORT_2` (defaults 3210/3211) so CI and local runs never fight
    over a fixed address. It asserts that unauthenticated requests never see
    dashboard content, that login/logout work end to end, that tampered,
    fabricated and **expired** cookies are rejected, that CSRF is enforced on the
    credentials callback, that off-origin `callbackUrl` values are not followed,
    that protected responses are not cacheable, that the login Server Action
    applies the redirect allowlist, that PWA assets stay reachable while signed
    out, that no credential material appears in any response body, and that a
    deployment with no admin configured fails closed. The expired-session test
    mints a genuine JWT that is already past its `exp` using the server's own
    secret, so it exercises the real expiry check rather than a malformed cookie.
  - `src/app/actions/__tests__/auth.test.ts` covers the login and logout Server
    Actions with Auth.js mocked, proving the redirect allowlist is wired to the
    form action path and that failures collapse to one generic message.
  - `tests/db/` (Phase 03B) is a PostgreSQL integration suite that runs against
    **real PostgreSQL** because every invariant it asserts is enforced by the
    server. It creates one throwaway database per test file, applies the full
    committed migration chain, and asserts the integrity rules: both trees'
    ancestry (self-parent, cycle, cross-product parent, deleted-ancestor
    rejection), terminal-parent rejection, sibling-order uniqueness, cascades,
    write-once inquiry snapshots, one-active-inquiry-per-product, message
    deduplication and the migration chain itself (clean apply, idempotent
    re-application, atomic rollback of a failed migration). Locally it uses a
    disposable cluster (`npm run test:db`); in CI, an isolated PostgreSQL
    service container designated by `RABET_TEST_PG_URL`. The suites skip cleanly
    when no cluster is designated, so `npm run test` stays green everywhere.
  - `src/lib/data/__tests__/` (Phase 03C-A) covers the data-access layer's
    error vocabulary (every SQLSTATE class, Drizzle's wrapped-error shape, and
    that connection strings and passwords never reach a safe message), its Zod
    validation schemas, and the driver contract that documents what the DB
    suites cannot exercise (`db.batch()` exists on the neon-http client and not
    on the integration client). The layer's own integration suites live in
    `tests/db/{settings,languages,templates}.test.ts` and assert the real SQL
    behaviour of the singleton, the currency allowlist, the text-direction rule,
    the one-row-per-template-per-language index and the 4096-character cap —
    plus every branch of the fallback chain.
  - Lint, typecheck, build **and** test are the CI gate as of Phase 02; Phase
    03B added a second CI job that applies the migrations to a service
    container, checks schema/migration consistency and runs the DB suites.
    Formal coverage thresholds, the security review and release hardening
    arrive in Phase 10.

## 7. Security considerations

- **Authentication exists as of Phase 02** (see ADR-009 and ADR-010). One
  administrator, email + password, Argon2id hash verification, encrypted JWT
  session cookie, 7-day expiry, no self-registration and no other roles.
- **Missing or invalid configuration fails closed.** If `AUTH_SECRET`,
  `ADMIN_EMAIL` or `ADMIN_PASSWORD_HASH` is absent, empty, or the hash is not an
  Argon2 PHC string, sign-in is refused and the dashboard stays unreachable.
  There is no default account and no bypass.
- **Authorization is layered** (ADR-010): an optimistic `proxy.ts` redirect plus
  an authoritative `requireAdmin()` used by layouts, Server Actions and Route
  Handlers.
- **CSRF is enforced by Auth.js** on the credentials callback: a POST without a
  valid token and cookie pair is rejected with `MissingCSRF` before the
  credentials are ever evaluated, and no session is issued.
- **No caching of authenticated responses.** Dashboard routes are declared
  `private, no-store, must-revalidate` in `next.config.ts`; the `/login` page
  carries `private, no-cache, no-store`. No service worker exists, so no
  authenticated payload can be cached on the device.
- **Sessions cannot be centrally revoked before expiry** (ADR-009). Logout
  clears the browser cookie; a cookie that has already left the device stays
  valid for up to its natural 7-day lifetime. Rotating `AUTH_SECRET` invalidates
  all outstanding sessions at once. This is a documented limitation, not a claim
  of revocation.
- **No application rate limiting** (ADR-011). The memory-hard cost of Argon2id is
  the per-attempt brake; a durable, externally enforced limiter (Vercel Firewall
  rate limiting or Upstash Ratelimit) is the recommended prerequisite for
  internet-facing access. An in-process counter is deliberately *not* used,
  because it is unreliable across serverless function instances.
- **Open-redirect protection.** Post-login destinations are validated against an
  internal allowlist; unvalidated values fall back to `/overview`.
- Secrets are never committed; `.env*` is git-ignored and `.env.example` holds
  placeholders only. Vercel Deployment Protection stays enabled.

## 8. Development and deployment workflow

```
Mobile  →  VPS development  →  GitHub  →  Vercel
```

1. **Mobile.** Interfaces are reviewed on a mobile browser first, because the
   merchant currently works from a mobile device.
2. **VPS development.** Code is written and validated on the development VPS
   with `npm ci`, `npm run lint`, `npm run typecheck` and `npm run build`.
3. **GitHub.** Finished work is pushed on a dedicated branch.
4. **Vercel.** The GitHub integration builds the branch.

The preferred Git workflow is: **feature branch → pull request → CI → Vercel
preview → review → merge to `main` → production deployment.** CI runs install,
lint, typecheck and build on every pull request, and Vercel produces a preview
deployment for review. Merging to `main` triggers the production build.

There is no custom release system and none is planned: Vercel's GitHub
integration is the only deployment path, and Vercel deployment protection stays
enabled.
