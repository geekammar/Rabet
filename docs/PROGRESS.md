# Progress — Rabet (رابط)

Current phase: **Phase 01 — Project Foundation & UI Shell**
Project stage: **Discovery & Development** (not commercial production)

Related: [ARCHITECTURE.md](./ARCHITECTURE.md) for decisions.

> This file tracks the **Phase 01B** final review, validation and documentation
> alignment pass. Phase 01 stays in **Review** until every acceptance criterion
> is actually satisfied.

---

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| **Phase 01** | Project foundation & UI shell | 🟡 **Review — validation passing, awaiting final acceptance** |
| Phase 02 | Admin authentication | Not started |
| Phase 03 | Database schema & migrations | Not started |
| Phase 04 | Settings & localization | Not started |
| Phase 05 | Service management | Not started |
| Phase 06 | Telegram bot onboarding | Not started |
| Phase 07 | Customer journey & orders | Not started |
| Phase 08 | Payment integration | Not started |
| Phase 09 | Order operations & messaging | Not started |
| Phase 10 | Testing, security & release hardening | Not started |

The base Vercel deployment and the GitHub integration were configured during
Phase 01, but release hardening (Phase 10) is **not** complete.

## What is done in Phase 01

### Foundation

- Next.js 16 App Router project initialised in the repository root with
  TypeScript in **strict mode**.
- Tailwind CSS v4 with a neutral design-token system (light + dark token sets).
- ESLint configured with `eslint-config-next` (flat config) and passing.
- `src/` directory with the `@/*` → `./src/*` import alias.
- `npm` as the package manager; `package-lock.json` committed.

### UI shell

- Public **landing page** at `/` (hero, feature overview, footer).
- **Dashboard shell** in the `(dashboard)` route group:
  - responsive sidebar (desktop) and slide-in drawer (mobile) sharing one
    navigation definition in `src/lib/navigation.ts`;
  - sticky header with a "Phase 1 · Preview" badge;
  - skip-to-content link, `aria-current="page"` on the active link, and a
    Radix-based drawer that manages focus and Escape-to-close;
  - constrained content width so the layout never overflows.
- **Overview page** with clearly labelled empty state and quick-links to every
  section — no invented statistics or revenue figures.
- **Placeholder pages** for Services, Orders, Customers, Payments, Bot Content,
  Telegram and Settings, each with a consistent, section-specific empty state.
- Reusable **`PageHeader`** and **`EmptyState`** components.
- Loading (`loading.tsx` skeleton), error (`error.tsx` boundary) and
  `not-found.tsx` patterns wired into the dashboard group.

### Tooling & documentation

- `npm run dev`, `npm run lint`, `npm run build`, `npm run typecheck` all work.
- GitHub Actions workflow runs install → lint → typecheck → build with no
  external secrets.
- `README.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`, `.env.example` and
  `.gitignore` written.

### Phase 01B — final review and documentation alignment

- The roadmap in every document was realigned to the approved ten-phase order
  (foundation → authentication → database → settings → services → Telegram →
  customers/orders → payments → operations → hardening).
- The development workflow (Mobile → VPS → GitHub → Vercel) and the preferred
  Git workflow (branch → PR → CI → Vercel preview → review → merge) were
  recorded in `README.md` and `docs/ARCHITECTURE.md`.
- Payment documentation was corrected: it no longer claims no other provider
  will ever be integrated. Telegram Stars remain the required method for
  digital goods inside Telegram; Binance personal payment links are noted as
  under evaluation for separately permitted contexts only, expiring by nature,
  and not implemented now.
- The root 404 page was given a `<main>` landmark so it matches the landmark
  structure of every other page.
- The base Vercel deployment is recorded as configured; release hardening stays
  incomplete and assigned to Phase 10.

## What is deliberately not implemented

Per the Phase 01 scope, the following are **absent by design**:

- Database connections or schema (Drizzle / Neon) — Phase 03.
- Authentication (Auth.js) — Phase 02. The dashboard is **not protected**.
- Telegram API calls or webhooks (grammY) — Phase 06.
- Payment APIs of any kind — Phase 08. Nothing is wired up.
- Customer, order or service CRUD — Phases 05 and 07.
- Background workers, queues or cron jobs.
- Real-time updates.
- Dark-mode toggle (token sets exist; the toggle is deferred).
- Localization / RTL (dashboard is English only; Arabic bot content is Phase 04).

No fake data, no fake statistics and no non-functional buttons are present.

## Constraints respected

- Digital goods and services sold inside Telegram must use **Telegram Stars**.
  No real payment integration is present. Binance personal payment links are
  being evaluated only for separately permitted contexts, are not implemented
  now, and can expire — so they are never assumed valid indefinitely. No
  external checkout capability is invented or promised.
- No actual secrets are requested, generated or committed.
- The dashboard is not presented as production-secure; it is labelled a preview
  and must not be described as secure until Phase 02 lands.

## Validation status

### Phase 01B re-run

All commands were executed again on the `chore/phase-01-final-review` branch:

| Command | Result |
| --- | --- |
| `npm ci` | ✅ exit 0 — 675 packages installed |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 — 12 static pages (10 routes + loading/error boundaries) |
| Route probe against `next start` | ✅ all 9 routes 200, `/nonexistent-page` 404 |

Structural checks on the server-rendered HTML all passed: `lang="en"`, a correct
`<title>` on every page, one `<main>` / `<aside>` / `<header>` / `<nav>`
landmark set on every dashboard page, exactly one `<h1>` per page with correct
`<h2>` descendants, `aria-current="page"` on the active link for all 8 dashboard
sections, the skip link resolving to `<main id="main">`, the mobile-nav trigger
present in the markup, and the "Phase 1 · Preview" / "Not production-secure"
markers visible. No server errors were logged.

Known non-blocking finding: `npm audit` reports 9 high-severity advisories, all
in dev-tooling transitive dependencies (`shadcn` registry, `ts-morph`,
`eslint-config-next`). None are runtime dependencies of the deployed app. They
are left untouched to avoid toolchain churn and are queued for Phase 10.

## Remaining manual verification

The development VPS has no browser installed, so these need a real browser and
must be checked from the user's mobile browser against the Vercel preview:

- [ ] Visual review of the responsive layout at mobile **and** desktop widths:
      landing page, overview, and each section placeholder.
- [ ] Confirm no horizontal overflow at 360px–400px viewport widths.
- [ ] Confirm the mobile drawer opens, moves focus correctly, navigates on tap
      and closes with `Escape`.
- [ ] Confirm keyboard tab order through the sidebar and header, and that the
      focus ring is visible.
- [ ] Confirm the loading skeleton and the error boundary render acceptably
      (both are wired into the route group but were not visually triggered).
- [ ] Confirm CI runs green on the Phase 01B pull request.
