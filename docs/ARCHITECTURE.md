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
| Validation | Zod | Installed in Phase 02 — sign-in input validation at the trust boundary |
| Testing | Vitest | Installed in Phase 02 — unit + auth integration suites |
| ORM | Drizzle | Planned — migration-friendly, type-safe |
| Database | PostgreSQL on Neon | Planned — serverless Postgres |
| Auth | Auth.js v5 (`next-auth@5.0.0-beta.32`) | Installed in Phase 02 — one admin, Credentials provider, encrypted JWT sessions |
| Password hashing | `@node-rs/argon2` | Installed in Phase 02 — Argon2id, OWASP-recommended parameters |
| Telegram | grammY | Planned — bot framework and webhooks |
| Hosting | Vercel | Base project configured in Phase 01; previews and production via the GitHub integration |

**Phase 01 installed the framework and UI rows plus the base Vercel hosting
project; Phase 02 added validation, testing, authentication and password
hashing.** Remaining future dependencies are intentionally absent so that
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

## 5. Data flow (future)

1. A customer sends a message to the bot.
2. grammY receives the update via a Vercel webhook and updates the customer's
   persistent state machine.
3. The customer selects a service and pays with Telegram Stars.
4. The bot records the order with separate payment and fulfillment statuses.
5. The merchant sees the order, customer and payment in the dashboard.
6. Drizzle validates every write; Zod validates every external input.

## 6. Testing strategy

- **Vitest** is installed and running (Phase 02).
  - Unit tests under `src/**/__tests__/` cover the auth modules: fail-closed
    admin configuration, credential verification, and the redirect allowlist.
  - `tests/auth.test.ts` is an integration suite driven over HTTP against the
    real production server (`next start`) on ports 3210/3211 with a synthetic,
    throwaway configuration: it asserts that unauthenticated requests never see
    dashboard content, that login/logout work end to end, that tampered and
    fabricated cookies are rejected, that protected responses are not cacheable,
    and that a deployment with no admin configured fails closed.
- Schema and migration tests against a Neon branch arrive in Phase 03.
- Lint, typecheck, build **and** test are the CI gate as of Phase 02; formal
  coverage thresholds, the security review and release hardening arrive in
  Phase 10.

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
- **No caching of authenticated responses.** Dashboard routes are declared
  `private, no-store, must-revalidate` in `next.config.ts`. No service worker
  exists, so no authenticated payload can be cached on the device.
- **Sessions cannot be centrally revoked before expiry** (ADR-009). Logout
  clears the browser cookie; a cookie that has already left the device stays
  valid for up to its natural 7-day lifetime. Rotating `AUTH_SECRET` invalidates
  all outstanding sessions at once.
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
