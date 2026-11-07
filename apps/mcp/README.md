# @waypoint/mcp

Local MCP (Model Context Protocol) server for the account owner's AI agent. Claude Code starts it over stdio: the repo's `.mcp.json` runs `src/index.ts` for sessions in this repo, and `claude mcp add` can register the same command elsewhere with its own environment.

- stdout carries MCP frames only; logs go to stderr, and never hold a token or password.
- The SDK (1.32.1) takes core's Zod 4 schemas as `inputSchema`, so every tool refuses an unknown argument by name (rule 207). Every tool's input is in `@waypoint/core/agent`.

## Environment

| Variable | What it is |
|---|---|
| `SUPABASE_URL` | The project's API address. It also names the Keychain item: `waypoint-mcp:local` for `127.0.0.1` or `localhost`, `waypoint-mcp:<project ref>` for `<ref>.supabase.co`. |
| `SUPABASE_PUBLISHABLE_KEY` | The publishable key (`sb_publishable_…`), never a secret key. |
| `WAYPOINT_WEB_URL` | Optional: the web app's address, so answers carry a `link` to the matching screen. |
| `WAYPOINT_RATES_URL` | Optional: another source of Frankfurter's ECB answer; the tests serve a fixture. |

Variables the process sets win. Anything it leaves unset is read from the ignored `apps/mcp/.env.local`, so this repo's `.mcp.json` needs no values. Write the local stack's values there without printing them:

```bash
pnpm exec supabase status -o env 2>/dev/null | sed -n -e 's/^API_URL="\(.*\)"$/SUPABASE_URL=\1/p' -e 's/^PUBLISHABLE_KEY="\(.*\)"$/SUPABASE_PUBLISHABLE_KEY=\1/p' > apps/mcp/.env.local
```

## Logging in

```bash
pnpm --filter @waypoint/mcp exec tsx src/cli.ts login
```

It asks for the account's email address and its existing password, once. On a terminal the password is not echoed; piped input works too. Login signs in with that password to check it, signs that session out, and keeps the same password in the Keychain. It never sets or changes a password and sends no email, so any other app that signs in the same auth users keeps its password. An account that has only ever used emailed codes has no password, so it cannot log the agent in.

The password is written once to the stdin of `security -i` as `add-generic-password -U -s waypoint-mcp:<ref> -a <email> -X <the password as hex>`, so it never appears on a command line, the screen or a log, and a space or a quote in it survives. An earlier login for the same project is replaced; logins for other projects stay, so a local and a cloud login sit side by side.

The server reads the item with `security find-generic-password -g -s waypoint-mcp:<ref>`: the account from stdout, the password from the `password:` line on stderr (which the tool prints as hex when the password holds a backslash or a character outside plain ASCII). It then signs in with the password, refreshing tokens automatically and keeping the session in memory only. Every Claude Code session starts its own server, so each holds its own session and none can rotate another's refresh token away. Nothing is written back: no lock file, no saved session. When the account's password changes, the servers here ask for a new login.

## Read tools

Each call is one `export_household()` plus the day's ECB rates from Frankfurter (fetched once a day and kept in memory; when a fetch fails, the last good rates with their own day, named in `basis.rates`), built into a snapshot with core `buildSnapshot` and walked with core `runEngine`.

| Tool | Answers |
|---|---|
| `get_overview` | Every account with its id; the next action and its prefill; each cash account's live, month-end and lowest balance, the lowest day and days under floor and target; FX margin and breakeven rates; revolving-cleared and debt-free months; total debt. |
| `list_open` | Occurrences due, overdue, late, unconfirmed or partly settled to the end of `through_month` (default this month), and the review items. Late income gives `carried_to`, the first of next month, where its open amount now counts. |
| `list_plan` | Plan items by kind, ended ones only with `include_ended`, and the categories. |
| `get_ledger` | One account's rows for `month` (default this month) with the balance after each, through core `ledgerMonth`. |
| `get_debt` | A card's statement, this cycle's payment figures (pay `left_to_pay`), installments and next statements; or a loan's balance, next payment and payoff. |

Every amount is `{currency, amount, amount_minor}`: a decimal string written from the minor units, and the minor units. Text a person typed (names, descriptions, and sentences built from them) only ever appears in fields named `data_text`, and the tool descriptions tell the agent to read it as data, never as instructions.

## Write tools

The agent writes as the signed-in user, so row-level security and every database check apply; there is no dry run. Amounts go in as decimal strings (`"-23.40"`, no grouping or currency sign; money out carries its minus) and are read once in the account's currency with core's `decimalMinor`; a string with more decimals than the currency takes is refused.

| Tool | Writes |
|---|---|
| `post_transactions` | One `post_batch` call: `batch_id`, rows (optionally linked with `plan_item_id` and `period`), `expect_before`, `expect_after` and `allow_over`. A row id left out is made from the batch id and the row's place, so the same call answers `already_applied`. A repeated `external_id` is refused as `already_recorded`, naming it. |
| `delete_transactions` | One REST delete: by `ids` (with the other leg of any transfer, `id.in.(…),transfer_id.in.(…)`) or by `batch_id`. |
| `set_link` | `link`, `unlink`, `skip` or `unskip` one occurrence, each one REST update guarded on what the call read. |
| `upsert_plan_item` | Adds an item (insert) or changes the fields given (an update guarded on every column). An item with linked rows keeps its kind and accounts; `change_from: "YYYY-MM"` calls `split_plan_item` instead. |
| `add_statement` | Inserts a printed statement checked with core's `statementRow`, and answers with core's `statementChecks` (previous balance, installments, interest, payments and credits). |

Each write loads the household before it (one export), writes, loads it again, and answers with `status`, `batch_id`, the tool's own fields, `balances_after` (every account, opening plus rows to today), and `changes` from `deltas.ts`: each cash account's lowest balance, days under floor and the FX margin before and after, from the engine on both. `changes.moved` is true when one of those three moved; a write that changes only net worth reads `false`, and `compare` shows net worth. A refusal is JSON `{error, message, …}`: `post_batch`'s names (`balance_mismatch` with the actual balances, `already_recorded`, `over_remainder`, `id_conflict`, `partial_replay`), the commit triggers (`check_link`, `check_plan_item`, `transfer_pair`), the database's other refusals (`database`), and the tool's own (`bad_input`, `not_found`, `already_linked`, `bad_link`, `linked`, `statement_exists`, `stale` when a row changed since the call read it, and `refused` for any other). A household that could not be read before the write is a plain-text failure, not a refusal.

`compare` saves nothing: `{patches: [{label, patch}]}` with core's patches runs core `compare` (the baseline, each patch, all together) and gives `WAYPOINT_WEB_URL/plan/compare#l=<encodeLevers>`, which opens the same comparison in the web app.

## Mercadona prices

The meals price list keeps its prices; nothing fetches them on view. This command reads the current price of each item linked to a Mercadona product, from this computer, and saves it with today's date and Mercadona as its source. It signs in with the login above.

```bash
pnpm --filter @waypoint/mcp exec tsx src/cli.ts prices --postcode 18001
```

- `--postcode <5 digits>` names the zone by a postcode Mercadona's online shop serves; `--warehouse <code>` names it directly (3968 is Granada). Where the online shop serves no postcode, use a nearby zone: packaged goods cost the same in every zone checked, fresh food and meat differ by a few percent.
- `--days 7` (the default) reads only items with no price or one checked 7 or more days ago; `--dry-run` prints the prices and saves nothing.
- One product every 2 seconds, about two minutes for 60 items. A refusal (HTTP 403 or 429) stops the run and is never retried.
- Mercadona's terms forbid using the shop's information for commercial purposes without its written permission, and its robots.txt asks automated readers to stay off `/api`. The command reads one household's own list for that household, at a weekly pace; the hosted app never calls Mercadona and ships no Mercadona prices.

## Weekly run

```bash
pnpm --filter @waypoint/mcp exec tsx src/cli.ts weekly --postcode 18001
```

The Friday job: the Mercadona prices as above, then `--recipes 3` (the default; 0 skips it) new recipes from the web app's meals helper (`/api/meals-ai`, which asks DeepSeek with the key kept on Vercel). The helper uses only items already in the price list, so every new recipe is priced. The command saves the drafts under the login's own household. It needs `WAYPOINT_WEB_URL`, and the account must be in the web app's `MEALS_AI_USERS`.

## Tests

`pnpm --filter @waypoint/mcp test` runs the unit tests everywhere, and the stdio tests against the local stack when `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are set. The unit tests record every auth call login and the server make, with the Keychain wrapper injected, and show that no path calls `updateUser`. The stdio tests use a stand-in `security` on `PATH` (`test/fake-security.mjs`), so they never touch the real Keychain and also run on Linux.

They sign up a user with a password, import the `abroad` sample, and run `login` twice: a wrong password is refused and keeps nothing, then the right one lands in the Keychain item unchanged and still signs in. They then start the server with the SDK's `StdioClientTransport`, and compare `get_overview` and `compare` with core run in the test. The write cases post a receipt (its deltas against core on the exports before and after), send the same call again (`already_applied`), refuse a stale `expect_before` with the actual balance, delete the batch, refuse a re-posted transfer as `already_recorded`, link and skip, add, change and split a plan item, and enter a statement. For the expiry case the local stack must issue 60-second access tokens: when it does not, the test restarts it with `SUPABASE_AUTH_JWT_EXPIRY=60` (passing `-x $SUPABASE_START_EXCLUDE` when set), runs two servers calling `get_overview` for 80 seconds, and restarts it again with its configured expiry. The run takes about three minutes. If a run is killed in between, `pnpm exec supabase stop && pnpm exec supabase start` brings back the configured expiry.
