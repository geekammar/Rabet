# Progress — Rabet (رابط)

Current phase: **Phase 01 — Project Foundation & UI Shell**
Project stage: **Discovery & Development** (not commercial production)

Related: [ARCHITECTURE.md](./ARCHITECTURE.md) for decisions.

---

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| **Phase 1** | Project foundation & UI shell | 🚧 **In progress — validation passing, pending final verification** |
| Phase 2 | Database (Neon + Drizzle) and Auth.js authentication | Not started |
| Phase 3 | grammY Telegram bot, webhooks, bot content | Not started |
| Phase 4 | Services, orders, customers, persistent customer state | Not started |
| Phase 5 | Telegram Stars payments | Not started |
| Phase 6 | Vercel deployment & hardening | Not started |

## What is done in Phase 1

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

## What is deliberately not implemented

Per the Phase 1 scope, the following are **absent by design**:

- Database connections or schema (Drizzle / Neon).
- Authentication (Auth.js) — the dashboard is **not protected**.
- Telegram API calls or webhooks (grammY).
- Payment APIs of any kind. Telegram Stars are planned; nothing is wired up.
- Customer, order or service CRUD.
- Background workers, queues or cron jobs.
- Real-time updates.
- Dark-mode toggle (token sets exist; the toggle is deferred).
- Localization / RTL (dashboard is English only; Arabic bot content is Phase 3).

No fake data, no fake statistics and no non-functional buttons are present.

## Constraints respected

- Digital goods sold inside Telegram must use **Telegram Stars**. No Binance or
  other payment integration is present.
- No actual secrets are requested, generated or committed.
- The dashboard is not presented as production-secure; it is labelled a preview.

## Validation status

All commands were executed in the repository and passed:

| Command | Result |
| --- | --- |
| `npm install` | ✅ completed |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 — 12 routes prerendered as static |
| `npm run dev` (manual smoke test) | ✅ all routes 200, `/nonexistent` 404, no console errors |

Smoke tests verified: landing page hero copy, overview empty state, every
section placeholder, the 404 page, page `<title>` values, document landmarks
(`nav` / `main` / `header` / `aside`), heading hierarchy, the `lang="en"`
attribute and `aria-current="page"` on the active navigation link.

## Remaining manual verification

- [ ] Review the responsive layout at mobile and desktop widths in a browser.
- [ ] Confirm keyboard navigation: tab through the sidebar, open the mobile
      drawer with the keyboard, and close it with `Escape`.
- [ ] Confirm the accessibility tree: landmarks, headings and the skip link.
- [ ] Confirm CI runs green on GitHub after the first push.
