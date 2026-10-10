# Progress — Rabet (رابط)

Current phase: **Phase 01 — Project Foundation & UI Shell**
Project stage: **Discovery & Development** (not commercial production)

Related: [ARCHITECTURE.md](./ARCHITECTURE.md) for decisions.

> This file tracks the **Phase 01C** mobile-first UX and PWA foundation pass on
> top of the Phase 01B final review. Phase 01 stays in **Review** until every
> acceptance criterion is actually satisfied.

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

### Phase 01C — Mobile-first UX & PWA foundation

**Mobile-first UX (Part A).** The existing visual identity is unchanged; the
shell was hardened for small touch screens:

- Every dashboard navigation link (desktop sidebar **and** mobile drawer) now
  has a `min-h-11` (44 × 44 CSS px) touch target, the mobile drawer trigger and
  drawer close button were raised to 44 px, and the landing-page CTAs, 404 and
  error-boundary buttons were raised to 44 px as well.
- The active navigation item gained a small accent bar alongside the existing
  background highlight, and its icon switches to the accent foreground colour,
  so the current section reads at a glance on a small screen.
- Display cut-out support: `viewport-fit=cover` plus `env(safe-area-inset-*)`
  padding on the sticky header, the sidebar, the mobile drawer and page
  bottoms, so standalone mode on a notched phone never hides chrome under the
  status bar or home indicator.
- The root layout switched from `min-h-full` to `min-h-dvh` so the on-screen
  browser chrome cannot push content out of view.
- The mobile drawer width is now `min(18rem, 100dvw - 1.5rem)`, so it can never
  overflow a ~280–320 px viewport.
- Focus rings were added to the plain text links that previously had none
  (header wordmark, sidebar logo, landing footer link), and the nav link ring
  gained an offset so it stays visible against the sidebar surface.
- Mobile tap highlight is disabled and vertical overscroll is suppressed so
  standalone usage feels native instead of flashing grey on every tap.

**PWA foundation (Part B).** Following the current Next.js App Router guidance:

- `src/app/manifest.ts` generates `/manifest.webmanifest` — `display:
  standalone`, `start_url: /overview`, `scope: /`, light `theme_color` and
  `background_color`, and `any` + `maskable` icons at 192 px and 512 px. Next.js
  auto-injects the `<link rel="manifest">`.
- Real, brand-faithful icons were generated into `public/icons/` from the
  existing brand mark (the lucide `Link2` glyph in the `primary` /
  `primary-foreground` design tokens, converted from OKLCH to sRGB):
  `icon-192x192.png`, `icon-512x512.png`, `maskable-192x192.png`,
  `maskable-512x512.png` (glyph kept inside the 80 % maskable safe zone) and a
  180 × 180 `apple-touch-icon.png` referenced through `metadata.icons.apple`.
- `src/app/favicon.ico` was replaced with the same brand mark (16/32/48 px).
- `metadata` gained `applicationName` and `appleWebApp` (capable, title,
  default status-bar style); the new `viewport` export carries `themeColor`.
- `scripts/generate-pwa-icons.py` is the stdlib-only generator for all of the
  above, so the assets stay reproducible from the brand tokens.

## What is deliberately not implemented

Per the Phase 01 scope, the following are **absent by design**:

- Database connections or schema (Drizzle / Neon) — Phase 03.
- Authentication (Auth.js) — Phase 02. The dashboard is **not protected**.
- Telegram API calls or webhooks (grammY) — Phase 06.
- Payment APIs of any kind — Phase 08. Nothing is wired up.
- Customer, order or service CRUD — Phases 05 and 07.
- Background workers, queues or cron jobs.
- Real-time updates.
- **Service worker / offline support.** This is an admin application; caching
  dashboard data or authenticated responses is a security risk and there is no
  proven offline requirement yet. See ADR-008 in
  [ARCHITECTURE.md](./ARCHITECTURE.md).
- **Web Push Notifications** and any VAPID key material.
- **A custom install button.** Installation relies on the browser's own prompt,
  which appears once the manifest, icons and HTTPS criteria are met. No fake
  install affordances exist.
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

### Phase 01C verification

| Command | Result |
| --- | --- |
| `npm ci` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0, no warnings |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 — 13 static pages (adds `/manifest.webmanifest`) |
| Route probe against `next start` | ✅ landing 200, all 8 dashboard routes 200, `/nonexistent-page` 404 |

Manifest and asset checks performed against the production server:

- `/manifest.webmanifest` returns 200 with `content-type:
  application/manifest+json` and parses as valid JSON; `start_url: /overview`,
  `scope: /`, `display: standalone` and four icons with explicit `purpose`
  values are all present and correct.
- All five icons plus `/favicon.ico` return 200 with the correct content type;
  the bytes served match the files in the repository (SHA-256), and the PNG
  dimensions read over HTTP are exactly 192², 512² and 180². The maskable
  glyphs sit inside the 80 % safe zone; the `any` glyphs survive a legacy
  circular launcher mask.
- The document head renders `<link rel="manifest">`, `<meta name="theme-color"
  content="#ffffff">`, `viewport` with `viewport-fit=cover`,
  `<meta name="mobile-web-app-capable" content="yes">`,
  `apple-mobile-web-app-title`, `apple-mobile-web-app-status-bar-style` and
  `<link rel="apple-touch-icon" sizes="180x180">`.
- Structural HTML checks from Phase 01B still pass: `lang="en"`, one `<h1>` per
  page, one `<main>` / `<aside>` / `<header>` / `<nav>` landmark set on every
  dashboard page, `aria-current="page"` on the active link, the skip link
  resolving to `<main id="main">`, and the 44 px touch-target classes present
  in the server-rendered markup.

**Security and scope review (no browser available on the VPS):** no service
worker, no Web Push, no VAPID key material and no caching layer were
introduced; `package.json` and `package-lock.json` are unchanged, so no new
dependency was added; a scan of tracked files for secret-like patterns
(RSA/ AWS key shapes, bearer tokens, committed connection strings) found
nothing; `.env.example` still holds commented placeholders only. Next.js
default cache headers were inspected: static asset and HTML responses carry no
private data (the shell has none), but the default `s-maxage` on prerendered
pages must be revisited in Phase 02 once authenticated responses exist. Vercel
Deployment Protection remains enabled and untouched.

## Remaining manual verification

The development VPS has **no browser installed** (no Chromium, Firefox,
Playwright or Puppeteer is available), so pixel-accurate and interactive checks
could not be run here. Static DOM/CSS inspection and HTTP probes were performed
instead — these are **not** a substitute for interactive browser testing. All
of the following need a real browser, ideally the user's Android device against
the Vercel preview:

- [ ] Visual review of the responsive layout at **320, 360, 390, 430, 768,
      1024 px and desktop**, on the landing page, the overview and each section
      placeholder. (Static review found no fixed width exceeding a 320 px
      viewport, but this was not pixel-measured in a browser.)
- [ ] Confirm no horizontal overflow at 320–400 px viewport widths.
- [ ] Confirm the mobile drawer opens, moves focus correctly, navigates on tap
      and closes with `Escape`; confirm the drawer never exceeds the viewport on
      a ~280–320 px screen.
- [ ] Confirm every navigation item and primary button presents a visible
      44 × 44 CSS px touch target.
- [ ] Confirm keyboard tab order through the sidebar and header, and that the
      focus ring is visible on every focusable element (including the plain
      text links that gained rings in this phase).
- [ ] Confirm the loading skeleton and the error boundary render acceptably
      (both are wired into the route group but were not visually triggered).
- [ ] Confirm the active-section accent bar renders as intended in both the
      sidebar and the drawer.

### PWA installation checks (require an Android device)

These cannot be validated without the target device and were **not** claimed as
passing:

- [ ] Chrome / Edge on Android shows the "Install app" / "Add to Home screen"
      action for the Vercel preview (manifest + icons + HTTPS criteria met).
- [ ] Installing launches a standalone window rooted at `/overview`, with the
      Rabet icon on the home screen and no browser chrome.
- [ ] The status bar area honours the white theme color and the header clears
      the display cut-out in portrait and landscape.
- [ ] The maskable icon is used by adaptive launchers without clipping the
      glyph, and the non-maskable icon survives circular launcher masks.
- [ ] On iOS Safari, "Add to Home Screen" picks up the 180 px Apple touch icon
      and the `apple-mobile-web-app` metadata.

No service worker is registered, so the installed app still requires a network
connection — this is intentional for an admin application in this phase.
