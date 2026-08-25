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
- Branch names are `eng-NN-short-title`. Linear's suggested branch name
  carries a `diego/` prefix; drop it.
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
and the failure mode is a transaction off by 1000×. Write tools therefore take a
decimal amount and convert it in `src/money.ts` — never by hand in a handler, and
never with `amount * 1000`.

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
src/index.ts            entrypoint: reads the environment, connects stdio transport
src/server.ts           builds the McpServer and registers every tool
src/client.ts           the only place `ynab` is imported: auth + plan resolution
src/errors.ts           maps a failed call to text the model can recover from
src/money.ts            decimal amounts in, milliunits out, on the write path
src/tools/registry.ts   the tool shape, and the one adapter onto the MCP SDK
src/tools/arguments.ts  arguments more than one tool takes, described once
src/tools/index.ts      every tool the server serves
src/tools/<tool>.ts     one file per tool, named after it
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

### The tool registry

`src/tools/registry.ts` is the only module that knows tools are served over MCP.
A `ToolDefinition` names itself, carries zod schemas for its arguments and its
result, states its four behaviour hints, and exposes a handler taking
`(args, { client })` and returning **plain data**. Nothing in a tool file mentions
JSON-RPC, stdio, or `CallToolResult`, so adding a Streamable HTTP transport later
touches this one module and no tool.

`defineTool` is an identity function. Its only job is to infer `Input` and
`Output` so a handler gets typed arguments without restating its schemas.

**All four annotations are required**, not optional as in the SDK's
`ToolAnnotations`. `destructiveHint` and `idempotentHint` are only meaningful when
`readOnlyHint` is false, but requiring them means no tool can reach M3 without
someone having stated its safety posture in writing. ENG-30 fixes the values each
kind of write tool must carry.

**`openWorldHint` is `false` throughout.** The tools reach an external service,
but their domain of interaction is closed and enumerable: the token holder's own
plans, accounts, and transactions. That is the distinction the hint draws — a web
search is open, a database is not.

**Handlers return data; the registry builds the result.** A tool with an
`outputSchema` must return `structuredContent`, and the spec asks it to repeat the
same payload as a serialized JSON text block for clients that only read `content`.
Doing that in the registry is what keeps it true of every tool. The text block is
compact JSON, not indented — with ~25 tools returning transaction lists, the
whitespace is real tokens in the model's context.

**Output schemas stay as loose as YNAB's own guarantee.** `structuredContent` is
validated against the `outputSchema` before it is returned, so a schema stricter
than the API turns a working read into a tool error. Ids are `z.string()`, not
`z.uuid()`, for exactly that reason: describe the shape in `.describe()`, constrain
only what YNAB actually promises.

**Ordering is by name, in the registry, not by hand.** `tools/list` returns tools
in registration order, and a stable order across restarts is what lets a client
cache the prompt prefix it builds from them. Sorting means no one can perturb it
by editing `TOOLS`, and `byName` compares codepoints rather than using
`localeCompare`, which varies with the host locale.

Tool names are snake_case with no prefix. The spec allows `[A-Za-z0-9_.-]` and
blesses dot-namespacing, but namespacing across servers is the client's job.

### Shared tool arguments

`src/tools/arguments.ts` holds the arguments more than one tool takes, for the
reason `money.ts` holds `moneyArgument`: an argument's description is the only
place its meaning is stated, and one worded well in one tool and badly in the
next is worse than one worded identically everywhere. `plan_id` appears on every
tool and `month` on most of the read surface, so both live here.

**`plan_id` and `month` arrive already optional; ids do not.** `plan_id` is
optional on every tool without exception, and `month` on every tool that has so
far taken one, so baking `.optional()` into those two means no tool can forget
it. An id is a filter on some tools (`account_id` on `list_transactions`) and the
subject of others (`transaction_id` on `get_transaction`), so `idArgument`
returns the bare schema and the call site adds `.optional()` where it belongs.

**Descriptions say what omitting the argument does.** A model that cannot tell
what happens when it leaves `plan_id` out will supply something to be safe, and
the only value it can supply is a guess. So the text spells out the fallback
chain in behavioural terms — the configured plan, then the last one opened —
without naming the environment variables behind it, which the model can neither
read nor set.

**Ids are opaque and the schema says so.** Every id description ends by naming
the tool that lists them. Same reasoning as the loose output schemas: the value
is YNAB's to shape, `z.uuid()` would reject a legal id before the call is made,
and telling the model where ids come from prevents more bad calls than a pattern
that only rejects them afterwards.

`"current"` is the one literal `month` accepts — verified against YNAB's
OpenAPI spec, which documents it on all six month path parameters. There is no
`"last"` or `"next"`; a tool wanting the previous month computes the date.

Output schemas are deliberately absent here. The transaction shape is shared
between `list_transactions` and `list_scheduled_transactions`, and the category
shape between `list_categories` and `list_money_movements`, but each should be
lifted out of whichever tool lands first rather than guessed at before either
exists (ENG-39).

### Transaction queries

`list_transactions` is one tool over six endpoints — `getTransactions`, the four
scoped variants and `getTransactionsByType` — because they are one query with
different filters, and six tools would make the model pick between six ways of
asking the same thing. `planQuery` in `src/tools/list-transactions.ts` turns the
arguments into the single call to make and the handler only runs the result.
Keeping the choice out of the call is what makes it checkable: given an
`account_id`, the plan says `getTransactionsByAccount` before there is a request
to inspect.

All five list endpoints send `since_date`, `until_date` and `type` themselves —
`node_modules/ynab/dist/apis/TransactionsApi.js` if that is ever in doubt. Older
notes saying the scoped variants take only some of the three are wrong for SDK
4.5.0, and none of the three is ever filtered in process.

**No endpoint takes two scopes, so the scopes are ranked**: `category_id`, then
`payee_id`, then `account_id`, then `month`. The first one present wins the
request and the rest are applied to the rows that come back — except `month`,
which becomes a date bound instead. A blank id or month counts as absent, as it
does in `resolvePlanId`.

The order is not about response size. `getTransactionsByCategory` and
`getTransactionsByPayee` are the only two that return the lines of a split
transaction as rows in their own right — everywhere else a split arrives as one
parent whose category reads `Split` — so an account filter and a date bound are
exact on either shape and a category or payee filter applied in process is not.
Category outranks payee because a residual category test cannot match a split at
all: YNAB leaves `category_id` unset on the parent and names its category
`Split`, so ranking payee first would drop every split it was asked for. The
residual payee test the chosen order leaves behind is exact on every ordinary
transaction and loses only a split line carrying no payee of its own — that line
is dropped even when the parent holds the payee asked for. Neither order is
lossless once a category and a payee are given together and a split is involved;
this one loses less.

**A `month` that loses becomes `since_date` and `until_date`, not a row filter.**
YNAB defaults `since_date` to one year ago on every list endpoint but the
by-month one, so an `account_id` beside a `month` would otherwise fetch a year of
that account to keep one month of it — and return nothing at all for a month
older than that year, which reads to the model as a plan holding no such
transactions. `planQuery` turns the month into its first and last day, resolving
`current` against the clock in UTC as YNAB would have, and intersects those with
whatever bounds the caller gave: the later since, the earlier until. Both bounds
are inclusive, which is what makes the translation exact rather than an
approximation of the prefix match it replaces. A month that does not read as
`YYYY-MM` falls through to that prefix match, which is where a month YNAB would
have rejected already ended up.

That one-year default is YNAB's own and it is documented only in their OpenAPI
spec — the SDK's generated code carries no parameter descriptions at all — so it
is stated where the model will read it: `since_date` says what omitting it
costs, and the tool describes an unfiltered call as returning the last year
rather than the plan's whole history.

`getTransactionsByType` is reached when `type` is the only filter given. The SDK
implements it as `getTransactions(planId, undefined, undefined, type)` — same
request, same response — so calling it names the endpoint YNAB documents for
that query rather than changing what happens.

**One output schema covers both response shapes.** `subtransactions` belongs to
`TransactionDetail`, `type` and `parent_transaction_id` to `HybridTransaction`,
so all three are optional, and `category_name` admits null because
`TransactionDetail` types it that way. Null never actually arrives — the SDK's
`FromJSON` mappers turn every null into `undefined` — but the schema follows the
types rather than the observed data, which is the safe direction. The mapper
names those two SDK types through `import type`, which `verbatimModuleSyntax`
erases entirely: no module is imported at runtime, and `client.ts` is still the
only place the SDK is reached.

**Deleted transactions are not filtered out, and `deleted` is reported only when
it is true.** YNAB returns a deleted row only to a delta request and this server
sends no `last_knowledge_of_server` yet, so the field is `false` on every row
these endpoints return today and a filter here would be policy that never runs.
When ENG-34 turns deltas on, a deleted row is the only way the model learns a
transaction went away, and dropping it would be exactly wrong.

`amount_currency` is dropped with the rest of the `_currency` companions, and
three more fields go on the way out: `import_payee_name` and
`import_payee_name_original`, because `payee_name` already carries the name
YNAB resolved, and a line's `transaction_id`, which repeats the id of the row
it is nested inside. On the highest-volume tool in the server those are tokens
spent saying nothing.

`since_date` and `until_date` are shaped `YYYY-MM-DD` rather than left as bare
strings, because `month` beside them takes the literal `current` and a model
trying the same on a date bound should be told so without spending one of 200
requests to find out. The check is a shape and not a calendar: `z.iso.date()`
would inline a 250-character regex into every `tools/list`.

### Money on the write path

Every money argument on a write tool is a **decimal amount in the plan's
currency**; `src/money.ts` converts it to milliunits at the handler boundary.
Reads keep passing YNAB's own `_formatted` / `_currency` fields through, so
nothing on that side does arithmetic.

Two things had to be said in the schema, because neither is guessable and both
fail silently. `moneyArgument` and `transactionAmountArgument` build the
`z.number()` and own the wording, so no tool can phrase either one differently or
forget it: the unit, with `123.93` spelled out against `123930`; and, on
transactions only, that outflows are negative.

**`toMilliunits` shifts digits, it does not multiply.** `123.93 * 1000` is
`123930.00000000001` — rounding that away would work, but the same rounding is
what turns a genuinely too-precise amount into a plausible one. Instead it takes
the shortest decimal string that round-trips the double (which is what
`Number.prototype.toString` returns), moves the point three places, and rejects
the value if a non-zero digit would fall off the end. So the precision test is
exact rather than a tolerance, and the rejection is honest.

**Nothing is rounded, and nothing is defaulted.** A fourth decimal place is a
mistake about what the amount is, and picking a neighbour for the model would
write a number nobody chose to a real financial record. `toMilliunits` throws a
`ToolError` naming the argument instead. For the same reason `undefined` passes
straight through rather than becoming `0`: on an update, `args.amount ?? 0` would
zero a real transaction, so the overload returns `undefined` and lets the field be
omitted.

Three decimal places, not two: milliunits are what YNAB stores, and currencies
with three decimal digits (KWD, BHD) use all of them. Capping at cents would
quietly break those plans.

### Error mapping

`src/errors.ts` turns whatever a handler threw into one sentence of advice.
`registerTools` wraps every handler in the `try` that calls it, so a tool file
never handles an API failure and every tool gets the same treatment.

**Failures are tool results, not JSON-RPC errors.** `isError: true` with text in
`content`; clients feed that back to the model, which is the only path that can
produce a recovery. An error result carries no `structuredContent` — the SDK
skips output-schema validation when `isError` is set, so a failure does not have
to satisfy a schema written for success.

Note what this does *not* achieve: ENG-23 asked to reserve JSON-RPC errors for
structural problems like an unknown tool, and `McpServer` makes that impossible.
Its `tools/call` handler catches everything, `McpError` included, and returns it
as `isError` — so "tool not found" and input-validation failures come back as
tool results too. Bypassing it would mean giving up `registerTool`. Left as is.

**Match on `error.id`, never `error.name`.** The SDK does not throw an `Error`
subclass for a non-2xx: it throws the parsed response body itself, so the value
is a plain `{error: {id, name, detail}}` object and `instanceof Error` is false.
`asYnabFailure` is therefore a shape test. The `id` is the status with an
optional sub-code (`403.1`), which `Number.parseInt` reduces to the status; the
sub-codes are matched first, so a lapsed subscription reads differently from an
expired trial. `name` is not reliable — a live 401 returns `unauthorized` where
[the docs](https://api.ynab.com/#errors) say `not_authorized`.

Because the SDK parses every body as JSON, a maintenance or proxy page arrives as
a `SyntaxError`, and a dead connection as a bare `TypeError` from `fetch`. Both
are mapped; anything left says plainly that it is a bug in the server.

**The 429 message carries the rolling window.** A model that reads "rate limited"
and nothing else retries immediately and burns what is left. The text states the
200/hour allowance, that the window rolls rather than resetting, that a retry now
cannot succeed, and that it should tell the user instead of looping. It cannot be
more precise than that: YNAB stopped returning `X-Rate-Limit` on 429s in v1.73.0,
and `new api(token)` takes only a token and a base URL, so there is no middleware
seam to read response headers through anyway. If ENG-34 needs live quota, that
seam has to be built first.

**No token can leak into a message.** Not by discipline but by construction —
`errors.ts` never receives the token, and `createClient` is the only thing that
ever holds it. Keep it that way rather than adding scrubbing.

`ToolError` is for failures this server raises deliberately, where the message is
already written for the model; it passes through with only the tool name added.
Read-only mode (ENG-30) is its first real user.

**Not-found messages echo the ids that were passed.** YNAB says only that
something was missing, never which id, so the registry hands `describeFailure`
the raw arguments and the 400/404/409 paths list every `*_id` and `month` among
them. That is as specific as the API allows.

### Omitted tool arguments

`arguments` is optional on `tools/call`, and several tools here take no required
argument at all, so `{"name": "list_plans"}` with no `arguments` is a legal
request. The
SDK at 1.30.0 parses `params.arguments` straight against the tool's schema, so
`undefined` fails validation and the call errors —
[#400](https://github.com/modelcontextprotocol/typescript-sdk/issues/400), which
real clients hit. It is fixed on `main` by
[#1404](https://github.com/modelcontextprotocol/typescript-sdk/pull/1404) but was
never backported to the 1.x line
([#1869](https://github.com/modelcontextprotocol/typescript-sdk/issues/1869)).

`connect()` in `src/server.ts` wraps the transport's `onmessage` to default
`params.arguments` to `{}`. **Always connect through it**, never `server.connect`
directly, or the harness will pass where a real client fails. Delete it, and this
section, when the SDK ships the fix — check on the next bump (ENG-38).

The same release should be checked for the schema dialect. ENG-22 asked for
JSON Schema 2020-12; the SDK hard-codes `$schema` to draft-07 for zod v4 schemas
and offers no way to change it. Both drafts are explicitly allowed by the spec,
and for our schemas the two are byte-identical apart from that one string, so this
is cosmetic — but it is a deviation from the ticket, not an oversight.

### Startup

`main()` builds the client *before* connecting the transport, so a missing token
kills the process with a readable reason instead of leaving a server whose every
call 401s.

`ConfigError` prints as a bare message: it is the user's own misconfiguration and
a stack trace would only bury it. Everything else still prints as `fatal:` with
its stack. The startup line on stderr names the resolved default plan, because
that is what every tool call omitting `plan_id` will use.

`createServer` reads nothing from the environment and attaches no transport, so
the test harness (ENG-35) can build a server over an in-memory transport with a
faked `YnabClient`. `index.ts` holds everything that only makes sense in a real
process: reading the environment, stdio, and exiting non-zero.
