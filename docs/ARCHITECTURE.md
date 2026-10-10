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

## 2. Tech stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js 16 (App Router) | One app for pages, API routes and bot webhooks |
| Language | TypeScript (strict) | `strict: true`, `@/*` → `./src/*` |
| UI | React 19 + Tailwind CSS v4 | Design tokens as CSS variables |
| Components | shadcn/ui (radix-nova) + lucide-react | Components are copied into the repo, not a dependency |
| Validation | Zod | Planned — schema validation at trust boundaries |
| Testing | Vitest | Planned — unit and integration tests |
| ORM | Drizzle | Planned — migration-friendly, type-safe |
| Database | PostgreSQL on Neon | Planned — serverless Postgres |
| Auth | Auth.js | Planned — admin-only authentication |
| Telegram | grammY | Planned — bot framework and webhooks |
| Hosting | Vercel | Base project configured in Phase 01; previews and production via the GitHub integration |

**Phase 01 installs only the framework and UI rows of this table, plus the base
Vercel hosting project.** Future dependencies are intentionally absent so that
no dead code or half-wired modules exist before their phase begins.

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
│   ├── services/         # /services
│   ├── orders/           # /orders
│   ├── customers/        # /customers
│   ├── payments/         # /payments
│   ├── bot-content/      # /bot-content
│   ├── telegram/         # /telegram
│   └── settings/         # /settings
```

The dashboard lives in a **route group** so that:

- Dashboard URLs stay short (`/overview`, not `/dashboard/overview`).
- The dashboard shell (sidebar + header) is defined once in the group layout.
- A boundary exists for Phase 2 to attach authentication without touching the
  public landing page.

### Component layout

```
src/components/
├── brand/         # Logo
├── dashboard/     # Shell pieces: sidebar, header, mobile nav, shared nav
├── ui/            # shadcn/ui primitives (button, card, badge, sheet, …)
├── empty-state.tsx
└── page-header.tsx

public/icons/      # PWA icons served as-is (any + maskable + apple touch)
scripts/           # generate-pwa-icons.py — stdlib-only icon generator
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

**Decision.** An order will carry two independent statuses: a **payment status**
and a **fulfillment status**.

**Rationale.** Payment and delivery of a digital service are distinct lifecycles.
A service can be paid but not yet delivered, or delivered while payment is being
confirmed. Collapsing them into a single state forces ambiguous values such as
"completed" and makes reporting unreliable. The two statuses are introduced by
the schema work in Phase 03 and exercised by the order work in Phase 07.

### ADR-005 — Telegram Stars first; payment providers stay modular

**Decision.** Digital goods and services sold inside the bot are paid with
Telegram Stars. No real payment integration is active yet — the project is in
Discovery & Development, and payment work belongs to Phase 08.

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
(see ADR-004). No payment code exists in Phase 01.

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

## 5. Data flow (future)

1. A customer sends a message to the bot.
2. grammY receives the update via a Vercel webhook and updates the customer's
   persistent state machine.
3. The customer selects a service and pays with Telegram Stars.
4. The bot records the order with separate payment and fulfillment statuses.
5. The merchant sees the order, customer and payment in the dashboard.
6. Drizzle validates every write; Zod validates every external input.

## 6. Testing strategy (planned)

- **Vitest** for unit and integration tests (utilities, validators, bot flows).
- Schema and migration tests against a Neon branch.
- Lint, typecheck and build remain the Phase 01 gate in CI; formal test
  coverage, the security review and release hardening arrive in Phase 10.

## 7. Security considerations

- **No authentication exists yet.** Nothing in the dashboard is protected and no
  private business data is shown, because none exists. The interface is marked
  "Phase 1 · Preview" to make the stage obvious.
- Phase 02 will add Auth.js session protection for the `(dashboard)` route group
  before any administrative function or private data is introduced.
- **No caching of sensitive data is introduced in Phase 01C.** There is no
  service worker and no offline layer. Next.js defaults prerendered pages with
  `s-maxage` at the CDN edge; that is acceptable only while the shell contains
  no personalized or authenticated data — it must be replaced with
  `dynamic`/`private` rendering as part of Phase 02, before any customer,
  order, payment or session response is served.
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
