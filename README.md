# Rabet (رابط)

A lightweight **Telegram-based digital services management system** with a web dashboard.

Rabet connects a Telegram bot — where customers browse services and place orders — to a clean admin dashboard where a single merchant manages services, orders, customers and payments.

> **Status:** Phase 01 — Project Foundation & UI Shell (in review).
> The dashboard is a static UI shell only. There is no database, no authentication and no Telegram integration yet. It is **not production-secure**. See [docs/PROGRESS.md](./docs/PROGRESS.md).

---

## Tech stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, TypeScript, strict mode) |
| UI | React 19, Tailwind CSS v4, shadcn/ui (radix-nova), lucide-react |
| Validation (planned) | Zod |
| Testing (planned) | Vitest |
| ORM (planned) | Drizzle |
| Database (planned) | PostgreSQL on Neon |
| Auth (planned) | Auth.js |
| Telegram (planned) | grammY |
| Hosting | Vercel |

Phase 01 installs only the framework and UI rows, plus the base Vercel hosting project. Everything marked _planned_ is deliberately absent — see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the reasoning.

## Project structure

```
rabet/
├── .github/workflows/     # CI (install, lint, typecheck, build)
├── docs/                  # Architecture decisions and phase progress
│   ├── ARCHITECTURE.md
│   └── PROGRESS.md
├── public/                # Static assets
├── src/
│   ├── app/
│   │   ├── (dashboard)/    # Dashboard route group (shared shell)
│   │   │   ├── overview/
│   │   │   ├── services/
│   │   │   ├── orders/
│   │   │   ├── customers/
│   │   │   ├── payments/
│   │   │   ├── bot-content/
│   │   │   ├── telegram/
│   │   │   ├── settings/
│   │   │   ├── layout.tsx  # Sidebar + header shell
│   │   │   ├── loading.tsx # Skeleton loader for the group
│   │   │   └── error.tsx   # Error boundary for the group
│   │   ├── globals.css     # Design tokens + Tailwind
│   │   ├── layout.tsx      # Root layout (fonts, metadata)
│   │   ├── not-found.tsx   # Root 404
│   │   └── page.tsx        # Landing page
│   ├── components/
│   │   ├── brand/          # Logo
│   │   ├── dashboard/      # Sidebar, header, mobile nav, shared nav
│   │   ├── ui/             # shadcn/ui primitives
│   │   ├── empty-state.tsx # Reusable empty state
│   │   └── page-header.tsx # Reusable page header
│   └── lib/
│       ├── navigation.ts   # Single source of truth for dashboard nav
│       └── utils.ts        # cn() class helper
├── .env.example            # Placeholder documentation for future env vars
├── next.config.ts
└── tsconfig.json           # strict mode, @/* → ./src/*
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

Open [http://localhost:3000](http://localhost:3000) for the landing page, or [http://localhost:3000/overview](http://localhost:3000/overview) for the dashboard.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Create an optimized production build |
| `npm run start` | Serve the production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run `tsc --noEmit` without emitting output |

## Environment variables

No environment variables are required in Phase 1. `.env.example` documents the variables that later phases will need. Copy it to `.env.local` and fill in real values only when the corresponding phase is implemented.

```bash
cp .env.example .env.local
```

> Never commit real secrets. `.env*` files are git-ignored.

## Documentation

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — stack, structure and architectural decisions.
- [docs/PROGRESS.md](./docs/PROGRESS.md) — phase status, what is done and what is pending.

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
| **Phase 01** | Project foundation & UI shell | **Review** |
| Phase 02 | Admin authentication | Not started |
| Phase 03 | Database schema & migrations | Not started |
| Phase 04 | Settings & localization | Not started |
| Phase 05 | Service management | Not started |
| Phase 06 | Telegram bot onboarding | Not started |
| Phase 07 | Customer journey & orders | Not started |
| Phase 08 | Payment integration | Not started |
| Phase 09 | Order operations & messaging | Not started |
| Phase 10 | Testing, security & release hardening | Not started |

The base Vercel deployment was already configured during Phase 01, but final release hardening (Phase 10) is not complete.

## Payments

Rabet is in **Discovery & Development** — no real payment integration is active and none is implemented in this phase.

- Digital goods and services sold inside Telegram **must** be paid with [Telegram Stars](https://telegram.org/blog/telegram-stars), as Telegram requires for digital goods sold inside bots.
- Binance **personal payment links** are being evaluated only for separately permitted contexts. They are not being integrated now.
- Personal payment links can expire, so they must not be assumed valid indefinitely.
- No external checkout capability is being invented or promised. Future payment handling will keep provider-specific code modular, and payment and fulfillment statuses will stay separate in the data model.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) (ADR-005) for the reasoning.

## Deployment

The application is hosted on Vercel. The base project and the GitHub integration were configured during Phase 01, so pushes to `main` build the production deployment and pull requests build preview deployments automatically. Vercel deployment protection stays enabled.
