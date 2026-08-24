# mcp-server-ynab

An MCP server wrapping the YNAB API. A single Node process speaking JSON-RPC over
stdio; the MCP client spawns it with a YNAB Personal Access Token in the
environment. No HTTP server, no hosting, no framework.

```
MCP client → spawns node process (stdio JSON-RPC) → ynab npm SDK → api.ynab.com
```

## Project tracking

**This project is tracked in Linear**, in the
[YNAB MCP Server](https://linear.app/arrecho/project/ynab-mcp-server-ccf1d7b0bee6)
project on the **Engineering** team (`ENG`). The project description there is the
source of truth for architecture decisions and the tool surface — read it before
proposing a design change.

Work is organised into four milestones:

| Milestone            | Covers                                                            |
| -------------------- | ----------------------------------------------------------------- |
| M1 — Foundation      | Repo, YNAB client, server bootstrap, errors, money conversion      |
| M2 — Read surface    | 11 read tools covering all 23 read operations                      |
| M3 — Write surface   | ~14 write tools, read-only mode, write-safety annotations          |
| M4 — Hardening & ship| Caching, test harness, docs, npm publish                           |

Conventions:

- Every change should map to an `ENG-` issue. If there isn't one, say so before
  writing code rather than silently widening scope.
- Branch names come from Linear: `diego/eng-NN-short-title`.
- Reference the issue in the commit body (`ENG-20`), so Linear links the work.
- If an issue's "Done when" can't be met as written, flag it — don't quietly
  redefine it.

## Commands

```bash
npm run dev            # run the server, loading .env (no build step — see below)
npm run build          # tsc → dist/, for publish
npm run typecheck      # tsc --noEmit
npm run lint           # biome check .
npm run format         # biome check --write .
npm run check          # lint + typecheck, what CI should gate on
```

## Toolchain

**Node 26 strips TypeScript types natively**, so `node src/index.ts` runs the
server directly with no build step. The `build` script exists only so published
consumers on older runtimes get plain JS. Two consequences:

- Source must stay **erasable**: no `enum`, no `namespace`, no constructor
  parameter properties. `erasableSyntaxOnly` in `tsconfig.json` enforces this at
  typecheck time — if it errors, rewrite rather than disable it.
- Relative imports carry `.ts` extensions so Node resolves them at runtime.
  `rewriteRelativeImportExtensions` turns those into `.js` on build. Write
  `./client.ts`, not `./client.js`.

TypeScript 7 (the native compiler) and Biome 2 for lint + format.

## Ground rules

**stdout is the JSON-RPC channel.** A stray `console.log` corrupts the protocol
stream and the client sees a parse error. All diagnostics go to `stderr`.

**Milliunits.** YNAB amounts are integers where `1000` = one currency unit. Reads
are covered by the SDK's `_formatted` / `_currency` fields; **writes are not**,
and the failure mode is a transaction off by 1000×. Conversion on the write path
is its own issue (ENG-24) — until it lands, don't hand-roll conversions in tool
handlers.

**Writes are real.** Creating transactions and updating budgeted amounts mutate
live financial records. There is no sandbox. Treat write tools accordingly:
annotate them, and honour read-only mode (ENG-30).

**Rate limit: 200 requests/hour per token**, rolling window. Caching and delta
requests (`last_knowledge_of_server`) are load-bearing, not optimisations
(ENG-34). Avoid designs that fan out to many endpoints per tool call.

**Budget is called "plan".** YNAB renamed it: every API group except
`CustomTransactions` and `Deprecated` takes `planId`. Follow the API and use
`plan` as the noun throughout — which keeps `set_category_budget` unambiguous,
with "budget" as the verb.

**Never commit a token.** `YNAB_ACCESS_TOKEN` lives in the environment or `.env`,
which is gitignored. See `.env.example`.

**The server never reads `.env` itself.** In production an MCP client spawns it
with the token already in the environment, and cwd is whatever that client
happened to be in — a cwd-relative `.env` would be unpredictable at best. Local
runs load it at launch instead: `npm run dev` passes
`--env-file-if-exists=.env`, which warns to stderr and continues when the file
is absent (plain `--env-file` exits 9). A real environment variable takes
precedence over the file, so a stray `.env` can never shadow the token a client
passed in.

## Protocol version

The current published MCP spec revision is `2026-07-28`, but the TypeScript SDK
at 1.30.0 still tops out at `2025-11-25`. Build against what the SDK supports and
bump when it ships support — `2026-07-28` defines backward compatibility with the
handshake-based revisions. Tracked in ENG-38.

## Documentation

Rationale lives here, not in code comments. Exported symbols carry a one-line
TSDoc saying *what* they are; *why* they have that shape belongs in this file, so
there is one place to read and one place to keep current.

Two kinds of comment survive in `src/`: an invariant a future editor would
plausibly break without it, and a pointer to the section here that explains the
surrounding decision. Anything longer has outgrown a comment.

Where a rule is YNAB's rather than ours, link the API docs with `@see` instead of
paraphrasing them — their wording is authoritative and ours goes stale. Verified
anchors worth knowing: [`#personal-access-tokens`](https://api.ynab.com/#personal-access-tokens),
[`#rate-limiting`](https://api.ynab.com/#rate-limiting),
[`#errors`](https://api.ynab.com/#errors),
[`#deltas`](https://api.ynab.com/#deltas),
[`#oauth-default-plan`](https://api.ynab.com/#oauth-default-plan). Note the SDK's
own JSDoc still cites the retired `api.youneedabudget.com` domain and pre-rename
anchors; use `api.ynab.com`.

## Layout

```
src/index.ts    entrypoint: builds the server, connects stdio transport
src/client.ts   the only place `ynab` is imported: auth + plan resolution
```

The tool layer stays transport-agnostic, so an HTTP transport can be added later
without reworking the tools.

### The client module

`src/client.ts` is the single place the `ynab` SDK is imported. Tool modules take
a `YnabClient` and reach the SDK through `client.api`, so authentication and plan
resolution have exactly one implementation. `YnabClient` is a plain interface,
which is the seam the test harness (ENG-35) substitutes a fake through — no
separate factory needed for it.

**The token stays local to `createClient`.** It goes straight into the SDK
constructor and is never stored on the returned client, logged, or put in an
error message. Anything added to this module has to keep that true.

**Plan resolution.** `plan_id` is optional on every tool, so handlers that need
one call `client.resolvePlanId(planId)`: the explicit argument, else
`YNAB_DEFAULT_PLAN_ID`, else the literal `"last-used"`. That last one is a free
fallback — the API resolves it server-side to the user's most recently opened
plan, costing no extra request and avoiding a guess when an account holds several
plans.

The API accepts a second literal, `"default"`, but only when default plan
selection is enabled, which is an OAuth-application feature
([docs](https://api.ynab.com/#oauth-default-plan)). We authenticate with a
Personal Access Token, so `default_plan` comes back empty and `"default"` is not
usable — deliberately left out of the chain rather than overlooked.

**Blank counts as absent** at every step. A model passing `plan_id: ""`, or an
env var set to the empty string, falls through to the next fallback rather than
becoming a request for a plan named `""`.

### Startup

`main()` builds the client *before* connecting the transport, so a missing token
kills the process with a readable reason instead of leaving a server whose every
call 401s.

`ConfigError` prints as a bare message: it is the user's own misconfiguration and
a stack trace would only bury it. Everything else still prints as `fatal:` with
its stack. The startup line on stderr names the resolved default plan, because
that is what every tool call omitting `plan_id` will use.

`declareToolsCapability()` registers a placeholder tool and immediately removes
it. McpServer wires the `tools/list` and `tools/call` handlers lazily, on first
`registerTool`; with an empty registry it would answer `tools/list` with `-32601`
and advertise no capability, so a client could not tell an empty server from a
broken one. `remove()` drops the entry but leaves the handlers in place, and
`tools/list` then returns `[]`. Delete it once real tools register (ENG-22).
