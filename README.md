# Rabet (رابط)

A lightweight **Telegram digital-product catalog** with a mobile-first admin dashboard.

Rabet connects a Telegram bot — where customers browse an arbitrarily deep catalog, interact with configurable product buttons, and open **inquiries** to the seller — to a clean dashboard where a single merchant manages the catalog, configures the button trees, and replies to customers.

> **Status:** Phase 03C-A — the server-only **settings & localization data access
> layer** implemented on `feat/phase-03c-settings-data-access`. Phases 01, 02,
> 03A, 03B, 03B-B and 03B-C are merged into `main`: the Phase 03 schema
> foundation (PR #6), the Neon development setup wizard (PR #7) and the Neon DEV
> GitHub Actions migration runner (PR #8) are all on `main`, and the dedicated
> Neon development database has the full migration chain applied and inspected.
> Phase 03C-A adds the typed data-access layer for `bot_setting`, `language`,
> `message_template` and `message_translation` — the functions the Phase 04
> settings and bot-content forms will call, with their business rules proven
> against real PostgreSQL — but **no dashboard UI yet**. **No** production
> database has been created or contacted, and **no payment processing exists at
> all** — the MVP has no checkout, no orders and no invoices; an inquiry is a
> conversation, not a purchase (ADR-013). The app is **not** production-secure
> until later phases land. See [docs/PROGRESS.md](./docs/PROGRESS.md),
> [docs/DATA_MODEL.md](./docs/DATA_MODEL.md) and
> [docs/PHASE_03B_HANDOFF.md](./docs/PHASE_03B_HANDOFF.md).
---

## Tech stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, TypeScript, strict mode) |
| UI | React 19, Tailwind CSS v4, shadcn/ui (radix-nova), lucide-react |
| Validation | Zod |
| Testing | Vitest (+ real PostgreSQL for the DB integration suites) |
| ORM | Drizzle ORM — schema in `src/db/schema`, migrations in `drizzle/` |
| Database | PostgreSQL on Neon — `drizzle-orm/neon-http` client (ADR-015) |
| Auth | Auth.js v5 (`next-auth@5.0.0-beta.32`), Credentials provider, JWT sessions |
| Password hashing | Argon2id via `@node-rs/argon2` |
| Telegram (planned) | grammY |
| Hosting | Vercel |

Phase 01 installed the framework and UI rows plus the base Vercel hosting project; Phase 02 added validation, testing, authentication and password hashing; Phase 03B added the ORM, the database client and the migration chain. Everything still marked _planned_ is deliberately absent — see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the reasoning.

## Project structure

```
rabet/
├── .github/workflows/     # CI (lint, typecheck, build, auth+unit tests, PostgreSQL DB job)
├── docs/                  # Architecture decisions, data model and phase progress
│   ├── ARCHITECTURE.md
│   ├── DATA_MODEL.md
│   ├── PROGRESS.md
│   └── PHASE_03B_HANDOFF.md
├── drizzle/               # Generated, reviewed SQL migrations (the source of truth)
│   ├── 0000_initial_schema.sql
│   ├── 0001_tree_and_snapshot_integrity.sql
│   └── meta/              # Drizzle journal + snapshots
├── drizzle.config.ts      # Drizzle Kit config (generate is offline; migrate needs DATABASE_URL)
├── public/
│   └── icons/             # PWA icons (any, maskable, Apple touch)
├── scripts/
│   ├── db-test-postgres.mjs     # Disposable PostgreSQL cluster for DB tests
│   ├── generate-admin-hash.mjs  # Local Argon2id hash provisioning helper
│   └── generate-pwa-icons.py    # Reproducible icon generator
├── src/
│   ├── app/
│   │   ├── (auth)/login/    # Sign-in page (public)
│   │   ├── (dashboard)/    # Dashboard route group (shared shell)
│   │   │   ├── overview/  catalog/  inquiries/  customers/
│   │   │   ├── bot-content/  telegram/  settings/
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
│   ├── db/                 # Database layer — server-only (Phase 03B)
│   │   ├── client.ts       # `getDb()` — lazy neon-http Drizzle client
│   │   └── schema/         # 14 tables in 7 domains + barrel index
│   ├── lib/
│   │   ├── auth/           # admin-config, credentials, session, redirect, schema, cache
│   │   ├── data/           # Server-only data access layer (Phase 03C-A)
│   │   │   ├── errors.ts        # typed errors + SQLSTATE mapping + safe messages
│   │   │   ├── languages.ts     # language CRUD, enable/disable, default resolution
│   │   │   ├── settings.ts      # bot_setting singleton: read/init/update
│   │   │   ├── templates.ts     # message templates, translations, fallback chain
│   │   │   └── index.ts         # barrel — the public surface; server-only
│   │   ├── navigation.ts   # Single source of truth for dashboard nav
│   │   └── utils.ts        # cn() class helper
│   ├── types/              # Auth.js type augmentation (role claim)
│   ├── auth.ts             # Auth.js configuration (Credentials + JWT)
│   └── proxy.ts            # Next.js 16 proxy — optimistic dashboard redirect
├── tests/
│   ├── auth.test.ts        # Auth integration suite (real production server)
│   ├── generate-admin-hash.test.ts
│   ├── db/                 # PostgreSQL integration suites (need a cluster)
│   └── stubs/              # `server-only` no-op stub for Vitest
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
| `npm run test` | Run every suite (unit + auth + DB). The DB suites **skip** when no cluster is designated |
| `npm run test:auth` | Run only the auth integration suite (`tests/auth.test.ts`) |
| `npm run test:db` | Start a disposable PostgreSQL cluster, run `tests/db` against it, then delete the cluster |
| `npm run db:generate` | Generate SQL migrations from `src/db/schema` into `drizzle/` — offline, touches no database |
| `npm run db:migrate` | Apply the committed migration chain to the database in `DATABASE_URL` |
| `npm run db:check` | Verify the schema and the committed migrations are consistent (needs a database) |
| `npm run db:setup:dev` | The one-command Neon **development** setup wizard — asks before any write, safe to re-run |

The auth integration suite builds the app and boots the real production server with a
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

## Database

Phase 03B implements the approved [data model](./docs/DATA_MODEL.md): fourteen
tables across seven domains — bot configuration, localized content, hierarchical
product categories, digital products with displayed prices, recursive
product action-button trees, localized action labels, Telegram customers,
product inquiries, inquiry messages and Telegram update deduplication. **No
financial entity exists anywhere** (ADR-013).

### Folder structure

| Path | Contents |
| --- | --- |
| `src/db/schema/` | The Drizzle TypeScript schema — one module per domain, re-exported by `src/db/schema/index.ts` |
| `src/db/client.ts` | `getDb()` — the lazy, `server-only` `drizzle-orm/neon-http` client (ADR-015) |
| `drizzle/` | The generated, human-reviewed SQL migrations plus `meta/` (journal + snapshots) |
| `drizzle.config.ts` | Drizzle Kit configuration |
| `tests/db/` | PostgreSQL integration suites (one throwaway database per file) |
| `tests/wizard/` | The setup wizard's flow, CLI and committed-secret suites |
| `scripts/db-test-postgres.mjs` | Disposable PostgreSQL cluster for local DB tests |
| `scripts/setup-neon-dev.mjs` | The Neon development setup wizard (`npm run db:setup:dev`) |
| `scripts/neon-dev-actions.mjs` | The GitHub Actions development-migration runner (`npm run db:dev:actions`) |

### The data access layer (Phase 03C-A)

`src/lib/data/` is the server-only data access layer over four of the fourteen
tables: `bot_setting`, `language`, `message_template` and `message_translation`.
It is the surface the Phase 04 settings and bot-content forms will call, and the
pattern the catalog, button and conversation layers of later phases will follow.

- **Every module imports `server-only`**, so none of it can reach a client
  bundle. A Client Component must never import from `@/lib/data`; a Server
  Component, Server Action or Route Handler imports the barrel.
- **Every function takes the database client as its first argument** —
  `readSettings(getDb())` in production, an injected PostgreSQL client in tests.
  There is no module-level client creation and no module-level query, so
  importing the layer never requires `DATABASE_URL` and a build cannot fail
  because a database is unconfigured.
- **No generic repository framework** — each function is one query with a
  documented purpose; what is shared is the error vocabulary, not plumbing.
- **Typed errors, safe messages.** Every failure is a `RabetDataError` with a
  stable `code`; raw driver errors are mapped by SQLSTATE and their text (which
  can carry the failed SQL and parameters) is never surfaced —
  `toSafeErrorMessage()` is the funnel that guarantees it.
- **Atomicity without interactive transactions.** Every write is a single
  statement idempotent at its own site (`ON CONFLICT …`), which is what the
  neon-http driver's constraint calls for (ADR-015). No Phase 03C-A path needs
  `db.batch([...])`; the first path that genuinely does will use it.

**Security boundary.** The layer performs no authorization check itself — by
design, there is exactly one administrator and one trust decision, and it
belongs to the caller. **Every future Admin Server Action and Route Handler that
calls into `src/lib/data/` must call `requireAdmin()` (`src/lib/auth/session.ts`)
at its entry boundary** (ADR-010). This phase exposes no unauthenticated
database-writing endpoint and adds none.

**The initialization contract.** No business data is seeded, automatically or
otherwise. Settings come into existence through one explicit flow: create the
default language (`ensureLanguage({ code: "en", …, isEnabled: true })`), then
initialize settings with the owner's explicit values
(`initializeSettings({ defaultLanguageCode, currency, displayName })`).
Re-running either step is a safe no-op; initializing over an existing row is a
`SETTINGS_ALREADY_INITIALIZED` error, never a silent overwrite; and which
currency the seller uses is an owner decision — `SAR` is a documented
recommendation, not a default. The full contract, including the interrupted-setup
and duplication rules, is in
[docs/PROGRESS.md](./docs/PROGRESS.md) ("The initialization contract").

### Generating migrations

`npm run db:generate` reads the TypeScript schema and writes version-controlled
SQL plus the journal and snapshot metadata to `drizzle/`. It is **offline** — it
never touches a database. After editing `src/db/schema/`, regenerate, review the
diff, then commit it: the migration files in `drizzle/` are the source of truth
that CI applies. **Never use `drizzle-kit push`** — it is not wired into any
script or CI step, by design.

### Applying migrations to a disposable database

Locally, PostgreSQL server tools and `npm run test:db` are enough — the script
starts a throwaway `initdb` cluster on a random loopback port with trust auth,
runs the suites, then deletes the whole data directory:

```bash
npm run test:db        # one command: start, test, stop + delete

# or step by step
node scripts/db-test-postgres.mjs start
export RABET_TEST_PG_URL="$(node -e 'console.log(require("/tmp/rabet-test-pg.json").url)')"
npx vitest run tests/db
node scripts/db-test-postgres.mjs stop
```

To apply the chain to a database you already have (development only):

```bash
DATABASE_URL="postgresql://user:password@host/devdb" npm run db:migrate
DATABASE_URL="postgresql://user:password@host/devdb" npm run db:check
```

### Setting up the Neon development database

The one-command wizard connects to the dedicated `Rabet_dev` project, inspects
it read-only, and applies the committed chain **after asking**:

```bash
npm run db:setup:dev            # interactive setup
npm run db:setup:dev -- --check # read-only preflight — no writes
```

It works identically on the first VPS and on every replacement VPS afterwards:
it recognizes an already-configured database, repeats nothing, creates no new
database, and leaves existing data untouched. It never runs `drizzle-kit push`,
never repairs schema drift automatically, and never prints a connection string.
The full operator guide — first VPS, replacement VPS, credential rotation,
direct vs pooled URLs, drift and interrupted setups — is in
[docs/NEON_DEV_SETUP.md](./docs/NEON_DEV_SETUP.md).

**If the development machine cannot reach Neon on TCP 5432**, apply development
migrations from GitHub Actions instead — a manual workflow
(`.github/workflows/neon-dev-migrate.yml`, exposed as the "Neon DEV database"
action) that reuses the wizard's tested inspection and migration logic. It is
`workflow_dispatch` **only** (a merge to main never migrates anything),
defaults to a read-only `inspect` mode, requires typing `MIGRATE_RABET_DEV`
for `migrate`, pins the endpoint host and database name to the committed
development identity, and never prints the connection string. The exact owner
workflow — secret, inspect first, then migrate — is §15.7 of
[docs/NEON_DEV_SETUP.md](./docs/NEON_DEV_SETUP.md#157-the-exact-owner-workflow-the-first-time).

### Running the DB tests

The DB suites run against **real PostgreSQL** because every invariant they assert
(ancestry triggers, partial unique indexes, write-once snapshots, cascades) is
enforced by the server. They read `RABET_TEST_PG_URL` and **never** read
`DATABASE_URL`, which may point at a shared or production cluster. With no
cluster designated they skip cleanly, so `npm run test` stays green on any
machine. CI provides an isolated PostgreSQL service container and sets
`RABET_TEST_PG_URL` for them.

In CI the DB job also runs `npm run db:check` to catch schema/migration drift.

### Production migrations

**No production database exists or has been contacted.** When one is provisioned,
migrations are run **by hand** from the development VPS against the **unpooled**
connection, after a manual snapshot — never from a Vercel build, never at
application startup, and never through `drizzle-kit push`. The step-by-step
operator runbook is in [docs/PHASE_03B_HANDOFF.md](./docs/PHASE_03B_HANDOFF.md).

## Environment variables

`AUTH_SECRET`, `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` are **required** in every
environment (local, preview and production). `DATABASE_URL` is required only by
the database layer and the migration scripts — the app **builds and serves every
current route without it**, and `getDb()` fails loudly with a credential-free
message on first use when it is absent. `.env.example` documents every variable
with placeholders and is the single source of truth; copy it to `.env.local` and
fill in real values.

```bash
cp .env.example .env.local
```

`RABET_TEST_PG_URL` is test-only: it designates the throwaway cluster the DB
suites create and drop databases on. It is never read by the application and
never points at `DATABASE_URL`.

> Never commit real secrets. `.env*` files are git-ignored.

## Documentation

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — stack, structure and architectural decisions.
- [docs/PROGRESS.md](./docs/PROGRESS.md) — phase status, what is done and what is pending.
- [docs/DATA_MODEL.md](./docs/DATA_MODEL.md) — the approved data model: the two recursive hierarchies (catalog + interaction buttons), the configurable button-action system, the inquiry model, security and integrity rules, infrastructure and migration plan.
- [docs/PHASE_03B_HANDOFF.md](./docs/PHASE_03B_HANDOFF.md) — Phase 03B implementation status, migration files, test commands and results, and the production migration runbook.

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
| **Phase 03A** | Data model & recursive button architecture **design** | **Merged** (PR #4, `269cf7c`) — documentation only |
| **Phase 03B** | Database schema, migrations & DB test foundation | **Merged** (PR #6) — schema + 2 migrations + client + 53 DB tests |
| **Phase 03B-B** | Neon development setup wizard | **Merged** (PR #7) |
| **Phase 03B-C** | Neon DEV GitHub Actions migration runner | **Merged** (PR #8) — a real DEV migration and a final read-only inspection have run |
| **Phase 03C-A** | Server-only settings & localization data access | **Implemented on `feat/phase-03c-settings-data-access`** — data-access layer for 4 tables + the initialization contract + 94 new tests; awaiting product-owner review |
| Phase 04 | Settings & localization **UI** | Not started — consumes the Phase 03C-A APIs |
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
