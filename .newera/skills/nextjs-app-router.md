---
name: nextjs-app-router
description: Build, fix and verify a Next.js App Router project on a Linux CI runner (GitHub Actions). Use for ANY task whose repo has package.json with a `next` dependency, or whose brief asks for a Next.js/React full-stack app. Covers scaffolding from zero (create-next-app), the build loop that converges, App Router file conventions, testing with Vitest, and how to produce the STATIC build output the deploy stage requires. Read this BEFORE the first `npm install`.
---

# Next.js App Router on a Linux runner

## Quick facts

- **Scaffold from zero:** `npx --yes create-next-app@latest . --ts --app --no-src-dir --import-alias "@/*" --use-npm --no-tailwind` — then add Tailwind manually only if the design needs it (`npm i -D tailwindcss @tailwindcss/postcss postcss`, one `@import "tailwindcss";` in `globals.css`, `@plugin` config optional). Never commit a scaffold into a subdirectory — the build runs at the repo ROOT.
- **Deploy contract (CRITICAL):** the deploy stage ships a STATIC directory with `index.html`. That means `next.config.js` must set `output: "export"` and the build produces `out/`. A server-rendered app (`output` unset, or using dynamic server features) will build green but is NOT deployable through the static pipeline.
- **Server features forbidden under `output: "export"`:** no `cookies()`, `headers()`, no route handlers with `force-dynamic`, no dynamic `generateStaticParams` misses. If the product genuinely needs a backend, build the API as a separate static-expressed contract or state the blocker honestly in `finish`.
- **Node 20** is preinstalled; `npm` (not pnpm/yarn) is the default — keep `package-lock.json` committed.

## The build loop (how a long task converges)

1. `npm install` (pin with `npm ci` when the lockfile exists).
2. `npm run build` — treat the FIRST build as a smoke test: it must pass before adding features.
3. Add features in small slices; after each slice: `npm run build` again. Never stack 5 features on a red build.
4. Verify output: `ls out/` must show `index.html` + `_next/`. Open `out/index.html` content in `head -50` to sanity-check the markup.
5. Tests: `npm i -D vitest @vitejs/plugin-react` and one smoke spec that renders the home page with `@testing-library/react`. `npx vitest run`.
6. Production check: `npx serve out/ -l 3000 &` then `curl -s localhost:3000 | head -20`, then `kill %1`.

## File conventions (App Router)

```
app/                    ← routes live here
  layout.tsx           ← root layout: <html><body> — REQUIRED, exactly one
  page.tsx             ← route segment UI (export default function)
  globals.css          ← imported by layout.tsx
  <segment>/page.tsx   ← nested routes = folders
components/            ← shared components (NOT app/)
lib/                   ← pure logic, fetchers, helpers
public/                ← static assets (favicon etc.)
```

- `layout.tsx` must render `<html>` and `<body>` — exactly once at the root. A nested layout must NOT repeat them.
- Every `page.tsx` is a Server Component by default. `"use client"` is opt-in per file — only on files that use hooks/events. Client components cannot `export const metadata`.
- Metadata: `export const metadata = { title, description }` in `page.tsx`/`layout.tsx` — replaces `<head>` tag fiddling.
- Dynamic routes: `app/[slug]/page.tsx` + `export function generateStaticParams()` returning `[{ slug: "…" }]` — REQUIRED under `output: "export"`.
- Images: use `next/image` with `unoptimized: true` in config under static export, or plain `<img>`.

## Common failure → fix table

| Error | Cause | Fix |
|---|---|---|
| `Error: Event handlers cannot be passed to Client Component props` | function prop sent from server to client component | add `"use client"` to the file that owns the handler |
| `use client` + `export const metadata` in one file | both forbidden | move metadata to the parent server layout |
| `Error: Page "app/x/page.tsx" is missing default export` | no `export default` | add `export default function Page()` |
| `window is not defined` | browser API in a server component | move to a `"use client"` file, or guard `typeof window !== "undefined"` |
| Hydration mismatch | time/random/markup differs server vs client | render the volatile part in `useEffect`, or `suppressHydrationWarning` on that node |
| `Module not found: Can't resolve '@/…'` | import alias typo | scaffold sets `@/* → ./*`; check `tsconfig.json` paths |
| Build green but `out/` missing | `output: "export"` not set | set it in `next.config.js` — the deploy NEEDS `out/` |

## Pre-finish checklist

- [ ] `npm run build` exits 0 with no warnings about server-only features
- [ ] `out/index.html` exists and references `/_next/` assets
- [ ] every page from the brief is a real route (`app/**/page.tsx`)
- [ ] `npx vitest run` (if specs were added) exits 0
- [ ] no `TODO`/placeholder components in shipped pages
- [ ] `request_deploy{subdomain, build_output_path:"out"}` called only AFTER all of the above