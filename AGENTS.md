<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Nokmel Agent Rules — Tier 0

## Read only the needed context

At the start of a task, read these four short Tier 1 files:

1. `docs/PRODUCT_BRIEF.md`
2. `docs/CURRENT_STATE.md`
3. `docs/ROADMAP.md`
4. `docs/RELEASE_POLICY.md`

Then read `docs/NOKMEL_ARCHITECTURE_BLUEPRINT.md` and only the Tier 2 domain document needed for the assigned slice. Use `docs/DOCS_INDEX.md` to locate historical evidence. Do not load every Markdown file or the full phase diary for routine work.

## Product and implementation discipline

- The product is Nokmel: invite-only Telegram commerce for physical goods. The first launch is the complete Starter selling journey, including P0 from the adopted Storefront & Merchant UX Design System.
- Product documents describe intent, not proof of implementation. Verify the current code, schema, CI, GitHub head and deployed SHA before claiming a feature exists or is ready.
- Keep buyer UI language separate from merchant-authored catalog content. UI locale changes interface copy and direction; it must not silently change the catalog text shown.
- Keep the buyer-facing Store Bot and merchant Notification Bot separate in identity, permissions and purpose.
- Prefer a coherent vertical slice with focused regression coverage. Do not build Growth/Pro/Intelligence features into Starter unless the owner changes scope.
- Preserve the existing Next.js conventions and tests. Do not run broad refactors without a scoped code audit and a behavior-preserving plan.

## Safety and approvals

- Keep one permanent Staging and one Production. Do not create another persistent QA service or copy Staging data to Production.
- Run CI on every PR. Desktop/browser acceptance proceeds with development; physical device testing stays separate and must not block routine PR review.
- Do not merge, deploy to Production, migrate Production data, enable a live feature, or configure a Production bot without Ammar's explicit approval.
- Staging changes must be exact-SHA pinned and verified before QA. If live SHA mismatches, stop before touching data or sending Telegram messages.
- Never put bot tokens, database URLs, personal buyer data or secrets in docs, PRs, prompts or logs.

## Reporting

For each implementation task, report exact PR/head SHA, changed behavior, tests/CI, migrations, environment effects, limitations, and a Drive handoff link when the task uses Agent Handoff. Separate facts, hypotheses and recommendations.
