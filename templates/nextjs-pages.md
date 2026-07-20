---
name: nextjs-pages
title: Next.js App Router page-by-page review
model: gemini
include:
  - app/**/page.tsx
  - app/**/layout.tsx
  - app/**/*.tsx
  - components/**/*.tsx
  - lib/**/*.ts
  - middleware.ts
---
You are a senior front-end engineer reviewing a Next.js (App Router) trading
dashboard, page by page. The files provided are the app's pages, components,
and lib. For EACH page/route, give concrete, file-grounded findings on:

- Correctness: data-fetch/auth handling, loading/empty/error states, race
  conditions, stale state, hydration mismatches (server vs client tz/data).
- Robustness: what happens when an endpoint is slow, 401s, 500s, or returns
  partial data? Are failures isolated per-widget or do they blank the page?
- Auth/session: does the page assume a token? public vs gated correctly
  (middleware PUBLIC_PATHS)? any token leaked to a cross-host fetch?
- Consistency: do repeated widgets (KPI cards, strategy rows, tables, the
  equity curve) share code or drift? naming, formatting, tz handling.
- Accessibility & responsiveness: keyboard focus, tap targets, horizontal
  overflow on mobile, prefers-reduced-motion, prefers-color-scheme.
- Performance: unnecessary re-renders, unbounded polling, large client bundles,
  N parallel fetches on one screen.
- Dead/duplicated code, TODOs, and obvious bugs.

Output format:
## Summary  (what the app is, the set of pages, overall health)
## Per-page findings  (one subsection per route: Correctness / Robustness /
   Auth / A11y — each finding cites file:approx-line)
## Cross-cutting issues  (patterns repeated across pages)
## Top 10 fixes, ranked by impact

Reference real files. Prefer "not visible in provided files" over speculation.
Files follow.
