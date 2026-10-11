# Rabet (رابط)

A lightweight **Telegram digital-product catalog** with a mobile-first admin dashboard.

Rabet connects a Telegram bot — where customers browse an arbitrarily deep catalog, interact with configurable product buttons, and open **inquiries** to the seller — to a clean dashboard where a single merchant manages the catalog, configures the button trees, and replies to customers.

> **Status:** Phase 03A — Data model & recursive button architecture **design** (documentation only).
> Phases 01 and 02 (UI shell and admin authentication) are merged into `main` and
> Production is ready for the merged commit. Phase 03A delivers a reviewed data model — two
> independent recursive hierarchies (catalog + interaction buttons), a configurable button
> action system, a unified inquiry model, an infrastructure recommendation and a migration
> plan — but deliberately **no** database, **no** schema code and **no** migrations yet
> (that is Phase 03B). There is no Telegram integration yet, and **no payment processing at
> all** — the MVP has no checkout, no orders and no invoices; an inquiry is a conversation,
> not a purchase (ADR-013). The app is **not** production-secure until later phases land.
> See [docs/PROGRESS.md](./docs/PROGRESS.md) and
> [docs/DATA_MODEL.md](./docs/DATA_MODEL.md).
---

## Tech stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, TypeScript, strict mode) |
| UI | React 19, Tailwind CSS v4, shadcn/ui (radix-nova), lucide-react |
| Validation | Zod |
| Testing | Vitest |
| ORM (planned) | Drizzle — designed in Phase 03A |
| Database (planned) | PostgreSQL on Neon — designed in Phase 03A |
| Auth | Auth.js v5 (`next-auth@5.0.0-beta.32`), Credentials provider, JWT sessions |
| Password hashing | Argon2id via `@node-rs/argon2` |
| Telegram (planned) | grammY |
| Hosting | Vercel |

Phase 01 installed the framework and UI rows plus the base Vercel hosting project; Phase 02 added validation, testing, authentication and password hashing. Everything still marked _planned_ is deliberately absent — see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the reasoning.

## Project structure

```
rabet/
├── .github/workflows/     # CI (install, lint, typecheck, build)
├── docs/                  # Architecture decisions and phase progress
│   ├── ARCHITECTURE.md
│   └── PROGRESS.md
├── public/
│   └── icons/             # PWA icons (any, maskable, Apple touch)
├── scripts/               # generate-pwa-icons.py — reproducible icon generator
├── src/
│   ├── app/
│   │   ├── (auth)/login/    # Sign-in page (public)
│   │   ├── (dashboard)/    # Dashboard route group (shared shell)
│   │   │   ├── overview/
│   │   │   ├── services/
│   │   │   ├── orders/
│   │   │   ├── customers/
│   │   │   ├── payments/
│   │   │   ├── bot-content/
│   │   │   ├── telegram/
│   │   │   ├── settings/
│   │   │   ├── layout.tsx  # Sidebar + header shell + server-side auth gate
│   │   │   ├── loading.tsx # Skeleton loader for the group
│   │   │   └── error.tsx   # Error boundary for the group
│   │   ├── actions/auth.ts # login + logout Server Actions
│   │   ├── api/
│   │   │   ├── admin/      # Protected Route Handler (the reuse pattern)
│   │   │   └── auth/[...nextauth]/  # Auth.js route handler
│   │   ├── globals.css     # Design tokens + Tailwind
│   │   ├── layout.tsx      # Root layout (fonts, viewport, metadata)
│   │   ├── manifest.ts     # Web App Manifest (PWA)
│   │   ├── favicon.ico     # Brand favicon
│   │   ├── not-found.tsx   # Root 404
│   │   └── page.tsx        # Landing page
│   ├── components/
│   │   ├── auth/           # login-form, logout-button
│   │   ├── brand/          # Logo
│   │   ├── dashboard/      # Sidebar, header, mobile nav, shared nav
│   │   ├── ui/             # shadcn/ui primitives
│   │   ├── empty-state.tsx # Reusable empty state
│   │   └── page-header.tsx # Reusable page header
│   ├── lib/
│   │   ├── auth/           # admin-config, credentials, session, redirect, schema, cache
│   │   ├── navigation.ts   # Single source of truth for dashboard nav
│   │   └── utils.ts        # cn() class helper
│   ├── types/              # Auth.js type augmentation (role claim)
│   ├── auth.ts             # Auth.js configuration (Credentials + JWT)
│   └── proxy.ts            # Next.js 16 proxy — optimistic dashboard redirect
├── scripts/
│   ├── generate-admin-hash.mjs  # Local Argon2id hash provisioning helper
│   └── generate-pwa-icons.py    # Reproducible icon generator
├── tests/                  # Integration tests over the real production server
├── .env.example            # Required environment variables (placeholders only)
├── next.config.ts
├── tsconfig.json           # strict mode, @/* → ./src/*
└── vitest.config.ts        # @/* alias + server-only stub for tests
```

## Getting started

### Prerequisites

- Node.js 22 or later
- npm 10 or later

### Install and run

```bash
# Install dependencies
npm install

# Start the development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the landing page. The dashboard at [http://localhost:3000/overview](http://localhost:3000/overview) now requires a sign-in — see below.

### Provision the administrator (required)

The dashboard is gated behind a single administrator declared by environment
variables. Until they are set, the app **fails closed**: sign-in is refused and
every dashboard route redirects to `/login`.

```bash
cp .env.example .env.local

# 1. Generate a session secret
npx auth secret

# 2. Generate an Argon2id hash of your admin password (interactive prompt —
#    nothing you type is echoed; only the hash is printed and the plaintext is
#    never written anywhere)
node scripts/generate-admin-hash.mjs

# 3. In .env.local, set ADMIN_EMAIL and paste the hash into ADMIN_PASSWORD_HASH
```

Then `npm run dev` and sign in at `/login`.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Create an optimized production build |
| `npm run start` | Serve the production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run `tsc --noEmit` without emitting output |
| `npm run test` | Run the Vitest unit + auth integration suites |
| `npm run test:auth` | Run only the auth integration suite (`tests/auth.test.ts`) |

The integration suite builds the app and boots the real production server with a
synthetic, throwaway configuration — no real secret, password or hash is used or
printed. The listen ports are configurable so runs never collide:

```bash
# defaults 3210 / 3211
npm run test:auth

# or choose your own
RABET_TEST_PORT=4210 RABET_TEST_PORT_2=4211 npm run test:auth
```

The suite reaps every server it spawns and removes its temp environment directory
on the way out, on success and on failure.

## Environment variables

`AUTH_SECRET`, `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` are **required** in every
environment (local, preview and production). `.env.example` documents all of
them with placeholders and is the single source of truth; copy it to
`.env.local` and fill in real values.

```bash
cp .env.example .env.local
```

> Never commit real secrets. `.env*` files are git-ignored.

## Documentation

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — stack, structure and architectural decisions.
- [docs/PROGRESS.md](./docs/PROGRESS.md) — phase status, what is done and what is pending.
- [docs/DATA_MODEL.md](./docs/DATA_MODEL.md) — Phase 03A data model: the two recursive hierarchies (catalog + interaction buttons), the configurable button-action system, the inquiry model, security and integrity rules, infrastructure and migration plan.

## Development workflow

Work moves in this order:

1. **Mobile** — the interface is reviewed on a mobile browser first, because that is the primary viewing device right now.
2. **VPS development** — code is written and validated on the development VPS.
3. **GitHub** — finished work lands in the repository on a dedicated branch.
4. **Vercel** — the GitHub integration builds the preview and production deployments.

The preferred Git workflow is:

> feature branch → pull request → CI → Vercel preview → review → merge to `main` → production deployment

No custom release system is used or planned; Vercel's GitHub integration handles builds.

## Roadmap

Development follows this fixed feature order.

| Phase | Scope | Status |
| --- | --- | --- |
| **Phase 01** | Project foundation & UI shell | **Merged** |
| **Phase 02** | Admin authentication | **Merged** (PR #3, `5e3bc7e`) — manual device checks and rate limiting remain open |
| **Phase 03A** | Data model & recursive button architecture **design** | **Revised design complete** — documentation only, no implementation |
| Phase 03B | Database schema & migrations implementation | Not started |
| Phase 04 | Settings & localization | Not started |
| Phase 05 | Catalog & Button Tree Editor | Not started |
| Phase 06 | Telegram bot onboarding | Not started |
| Phase 07 | Customer journey, inquiries & messaging | Not started |
| Phase 08 | Payment integration (**deferred** — Telegram Stars) | Deferred — see ADR-013 |
| Phase 09 | Inquiry operations & admin messaging | Not started |
| Phase 10 | Testing, security & release hardening | Not started |

The base Vercel deployment was already configured during Phase 01, but final release hardening (Phase 10) is not complete.

## Payments

**There are no payments in the MVP.** Rabet is in **Discovery & Development** as a
digital-product catalog with displayed prices and **seller inquiries**.

- An **inquiry** is a tracked conversation between a customer and the seller. It is **not**
  a purchase: no order, no invoice, no charge and no payment state is created. A displayed
  price is a quote, and the price the customer saw is frozen onto the inquiry.
- Rabet integrates **no** payment gateway, no Binance API, no Vodafone Cash API, no
  financial webhooks, no payment-proof workflow and no settlement engine. Nothing is wired
  up and no payment entity exists in the data model.
- **Telegram Stars guardrail.** Rabet offers digital services, and Telegram requires
  [Telegram Stars](https://core.telegram.org/bots/payments-stars) for **real digital
  goods/services sold inside bots and Mini Apps — including where an external payment page
  exists**. The bot's external-link button is therefore for **information pages only** and
  must never be framed or used as a checkout or payment redirect, or as a Stars workaround
  ([Bot Developer Terms](https://telegram.org/tos/bot-developers) §6.2).
- **Future real checkout.** When an in-bot digital sale is explicitly required, it must be
  built on compliant Telegram Stars checkout (or the commerce must genuinely live outside
  the bot's checkout/referral flow). That is a separate, deferred feature with a designed
  additive path — not something the current model blocks or assumes.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) (ADR-013) and
[docs/DATA_MODEL.md](./docs/DATA_MODEL.md) §16 for the reasoning.

## Mobile-first UX

The merchant works from a mobile device, so the dashboard is built and reviewed
mobile-first at 320, 360, 390, 430, 768 and 1024 px and on desktop:

- The sidebar collapses into a focus-managed drawer below the `md` breakpoint;
  both surfaces share one navigation definition.
- Navigation items and primary controls meet a 44 × 44 CSS px touch target.
- `viewport-fit=cover` with `env(safe-area-inset-*)` padding keeps the header,
  sidebar, drawer and page content clear of notches and the home indicator in
  standalone mode.
- Layouts are width-constrained so nothing scrolls horizontally.

Interactive verification still needs a real mobile browser — see the remaining
manual checks in [docs/PROGRESS.md](./docs/PROGRESS.md).

## Security posture

What Phase 02 provides, and what it deliberately does not.

**In place:**

- One administrator declared by environment variables; no registration, no other
  accounts, no roles.
- Argon2id password hashing (19 MiB memory-hard); the plaintext password is never
  stored, logged or compared in the clear.
- Fail-closed configuration — a missing or invalid `ADMIN_PASSWORD_HASH` disables
  sign-in entirely. No default account, no bypass.
- Layered authorization: an optimistic `proxy.ts` redirect plus an authoritative
  `requireAdmin()` used by every protected layout, Server Action and Route Handler.
- Encrypted, `HttpOnly`, `Secure`, `SameSite=lax` session cookie with a 7-day
  expiry; CSRF enforced by Auth.js on the credentials callback; `private, no-store`
  cache headers on every dashboard route and on `/login`.
- Open-redirect protection: post-login destinations are validated against an
  internal allowlist.

**Documented limitations — not claims of protection:**

- **Sessions are stateless JWTs and cannot be centrally revoked before they
  expire.** Logout clears the browser cookie; a cookie that has already left the
  device remains valid up to 7 days. Rotating `AUTH_SECRET` invalidates all
  outstanding sessions at once. See ADR-009.
- **There is no application rate limiter.** The memory-hard cost of Argon2id is
  the only per-attempt brake, and an in-process counter is *not* reliable across
  Vercel serverless instances, so none is shipped or claimed. Before
  internet-facing access, enable a durable, externally enforced limit — a Vercel
  Firewall rate-limit rule on the sign-in endpoints (no code required) or Upstash
  Ratelimit. Until then, keep Vercel Deployment Protection on. See ADR-011.

**Dependency advisories.** `npm audit` reports 9 high-severity advisories. Every
one traces to a single root package (`braces`, a stack-exhaustion DoS) reached
only through development tooling — `eslint-config-next` and the `shadcn` CLI's
`ts-morph` / `fast-glob` subtree. **No runtime or authentication dependency is
affected.** `shadcn` was moved to `devDependencies` in Phase 02B, which removes
that entire subtree from the production dependency tree. `npm audit fix --force`
was deliberately not run: its only offered fix is a breaking downgrade of the
`shadcn` CLI. Residual dev-tooling advisories are tracked for Phase 10.

## Progressive Web App

The dashboard is installable to a home screen. Next.js generates the manifest
from `src/app/manifest.ts` at `/manifest.webmanifest`: `display: standalone`,
`start_url: /overview`, `scope: /`, a light theme color, and `any` + `maskable`
icons at 192 and 512 px. A 180 × 180 Apple touch icon and the favicon complete
the set. All assets are real images generated from the brand mark by
`scripts/generate-pwa-icons.py` (standard library only, no dependencies).

**Deliberate limitations** (see [ADR-008](./docs/ARCHITECTURE.md)):

- **No service worker and no offline support.** This is an admin application —
  caching dashboard data or authenticated responses is a security risk, and no
  proven offline requirement exists yet.
- **No Web Push Notifications.**
- **No custom install button.** Installation uses the browser's own prompt,
  which appears once the manifest, icons and HTTPS criteria are met.

Installation on Android has not yet been tested on a real device; the pending
checks are listed in [docs/PROGRESS.md](./docs/PROGRESS.md).

## Deployment

The application is hosted on Vercel. The base project and the GitHub integration were configured during Phase 01, so pushes to `main` build the production deployment and pull requests build preview deployments automatically. Vercel deployment protection stays enabled.
