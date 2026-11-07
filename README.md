# Waypoint

A debt-payoff and multi-currency cashflow planner for iOS, Android and web.

## Layout

- `apps/app` — the Expo app (Expo Router; iOS, Android and web from one codebase)
- `apps/mcp` — a local MCP server, so an AI assistant records money through the app's checked write function
- `packages/core` — money, dates, schemas and the projection engine; plain TypeScript with no React, Expo, Supabase, network or clock
- `tests/db` — database tests that sign in to a local Supabase with supabase-js
- `supabase/` — migrations and pgTAP tests

Design inputs (spec, DBML, task board) are kept outside the repo, because they hold personal data.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test          # core, app and mcp unit tests
pnpm test:db       # needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY
pnpm --filter @waypoint/mcp exec tsx src/cli.ts login   # the agent's login: the account's existing password, kept in the Keychain (apps/mcp/README.md)
pnpm --filter @waypoint/core bench   # walk timings on the Mark-size sample; add NODE_OPTIONS=--jitless for the CI gate
pnpm web           # Expo dev server for the web build
pnpm exec supabase --version   # always the pinned CLI, never the global one
pnpm exec supabase start       # local stack (Docker)
pnpm exec supabase db reset && pnpm exec supabase test db   # migrations, then the pgTAP tests
pnpm exec eas --version
```

`pnpm test:db` reads the local API and publishable key from the environment. Export them from the running stack without printing them:

```bash
eval "$(pnpm exec supabase status -o env 2>/dev/null | sed -n -e 's/^API_URL=/export SUPABASE_URL=/p' -e 's/^PUBLISHABLE_KEY=/export SUPABASE_PUBLISHABLE_KEY=/p')"
pnpm test:db roundtrip   # each fixture household: import, export, import into a second user, compare
pnpm test:db metrics     # each fixture household: the engine's metrics are the same after import and export
```

The app reads `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (listed in `apps/app/.env.example`). Write the local values into the ignored `apps/app/.env.local`, again without printing them:

```bash
pnpm exec supabase status -o env 2>/dev/null | sed -n -e 's/^API_URL="\(.*\)"$/EXPO_PUBLIC_SUPABASE_URL=\1/p' -e 's/^PUBLISHABLE_KEY="\(.*\)"$/EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=\1/p' > apps/app/.env.local
```

In development, `/dev/data` signs in to a local account with a password and shows the data layer's numbers. Any route takes `?sample=abroad`, `?sample=us-cards-car` or `?sample=mortgage` and opens that sample read-only.

Routes live in `apps/app/src/app`. The tabs are in `(tabs)`: Today at `/`, then `/months`, `/money`, `/debts`, `/plan`, `/meals` and `/lending`. Pages such as `/money/<account>`, `/plan/compare` and `/settings` are pushed over them, and `/add`, `/statement` and `/reconcile` open as sheets. Screen state is in the URL: `/months?month=2027-03&view=chart`, and Compare's levers after `#l=`.

`pnpm --filter app bundle-size` exports the web build and gzips the JavaScript its `index.html` loads. It fails above 500 kB (an estimate of the first load). `apps/app/metro.config.ts` resolves zod's locale list to English only, which keeps about 40 kB of other languages out of every bundle.

Today and Welcome are in that first load; every other screen, sheet and the chart plot load later as one chunk, through `import('…/screens/tabs')`. Keep a new screen in that chunk: when two later chunks share a module, Expo moves it into a `__common` file that `index.html` loads first. Code only those screens use goes in a module the first screen does not import, such as `@waypoint/core/compare` for Compare's levers, since a module the first screen needs ships whole, with every export a later screen uses.

Native modules are added with `pnpm --filter app exec expo install <pkg>`, which picks the versions Expo SDK 57 is tested with (react-native 0.86.3, react 19.2.3).

## Database

Waypoint's thirteen tables (six for the money, seven for meals) and seven functions live in the `waypoint` schema; the trigger functions the tables use live in `private`. The public schema holds none of them, so Waypoint can share a Supabase project whose `public` already has its own tables (both apps have an `accounts` table). Every client asks for the schema: the app's `PostgrestClient` and supabase-js in the MCP server and `tests/db` set `schema: 'waypoint'`. `supabase/config.toml` lists `waypoint` after `public` in `[api] schemas`, so a request without a schema still reaches `public`. A change to that list needs `pnpm exec supabase stop && pnpm exec supabase start`; `db reset` keeps the running API's list.

On a hosted project:

- Link it and apply the migrations with `pnpm exec supabase db push`.
- Each migration adds before it removes, because installed phones run older JavaScript.
- Add `waypoint` after `public` to the project's exposed schemas (Data API settings in the dashboard, or `[api] schemas` with `config push`).
- Sign-in emails carry a 6-digit code (`supabase/templates`). Supabase's built-in sender only reaches the project's own team, so a project with other users needs a custom SMTP sender.

A household moves between projects through `export_household` and `import_household` (below).

## Import a household into a project

```bash
pnpm import:cloud --env <env file> --file <household JSON> [--replace]
```

The env file needs `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; other lines are skipped. The command checks the file with core's import schema, asks for the account's email and password (the password is never shown) and calls `import_household`. It then reads the household back with `export_household` and compares it with the file: rows per table, each cash account's balance and each card's latest statement total less the card credits after its cut, matched by account name. It prints OK, or MISMATCH and exits 1. An account that already has a household is refused. With `--replace` it asks you to type REPLACE, deletes the `households` row (every other Waypoint row of the account goes with it by cascade) and imports the file. It never deletes the login. Its tests run with `pnpm test:db import-to-cloud`.

## CI

GitHub Actions runs install, typecheck, lint, test, the walk bench under `node --jitless` (it fails when the median full walk passes 90 ms on the runner, which measured 66 ms on 8 Oct 2026; the Mac target is 30 ms and the phone limit is 50 ms, measured on the device), `expo install --check` and the web bundle-size gate on every push. A database job starts the local Supabase stack and runs the pgTAP tests, the MCP server's stdio tests (which restart the stack with 60-second tokens and back) and `pnpm test:db` when `supabase/`, `packages/core/`, `tests/db/` or `apps/mcp/` change.

## Web deploy

The web build deploys to Vercel (root `apps/app`, settings in `apps/app/vercel.json`): every push to `main` goes to production, and every other branch gets a preview. Its environment holds `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `EXPO_PUBLIC_WEB_URL`; the same three are EAS `production` variables for phone builds. Deep links load on reload through the rewrite to `index.html`. `apps/app/public/sw.js` only removes a service worker an earlier app left on the same domain; the app registers none.

The `/api` functions keep the DeepSeek key on Vercel (`DEEPSEEK_API_KEY`, and `DEEPSEEK_MODEL` to change the model), each behind a list of user ids: `/api/meals-ai` reads `MEALS_AI_USERS`, and `/api/pdf-read` reads `PDF_AI_USERS`, or `MEALS_AI_USERS` when it is unset. `/api/pdf-read` is Fill from PDF on the Statement and Add sheets: it takes the PDF's text with pdf.js (unpdf), masks card and account numbers, asks DeepSeek for the figures and checks them; it keeps nothing, and the sheet saves only when the person does. `pnpm exec tsx apps/app/scripts/pdf-read-try.mts statement <file.pdf> [currency] [password]` reads one file the same way; without `DEEPSEEK_API_KEY` it stops before DeepSeek and prints counts only. `apps/app/scripts/make-pdf-fixtures.py` writes the made-up PDFs its tests read.

`/api/mercadona` is Add an item's product search in Mercadona's shop. It needs `MERCADONA_ALGOLIA_APP_ID` and `MERCADONA_ALGOLIA_KEY`, the application id and public search-only key that Mercadona's own web shop sends to its Algolia search (listed in `apps/app/.env.example`); without them it answers 503 `mercadona_not_configured` and searches nothing.
