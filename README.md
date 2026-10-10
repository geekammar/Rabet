# Rabet (رابط)

A lightweight **Telegram-based digital services management system** with a web dashboard.

Rabet connects a Telegram bot — where customers browse services and place orders — to a clean admin dashboard where a single merchant manages services, orders, customers and payments.

> **Status:** Phase 1 — Project Foundation & UI Shell.
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

Only the technologies in the first four rows are installed in Phase 1. Everything marked _planned_ is deliberately absent — see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the reasoning.

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

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| **Phase 1** | Project foundation & UI shell | In progress |
| Phase 2 | Database (Neon + Drizzle) and Auth.js authentication | Not started |
| Phase 3 | grammY Telegram bot, webhooks and bot content | Not started |
| Phase 4 | Services, orders, customers and persistent customer state | Not started |
| Phase 5 | Payments via Telegram Stars | Not started |
| Phase 6 | Deployment to Vercel and hardening | Not started |

## Payments constraint

Digital goods and services sold inside a Telegram bot **must** be paid with [Telegram Stars](https://telegram.org/blog/telegram-stars). No other payment provider (including Binance) will be integrated, and no payment functionality exists in this phase.

## Deployment

The application is intended for Vercel. Deployment is **not** configured yet — it belongs to a later phase.
