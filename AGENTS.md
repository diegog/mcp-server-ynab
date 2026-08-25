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
| M3 — Write surface   | 15 write tools, read-only mode, write-safety annotations           |
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
are covered by the SDK's `_formatted` string; **writes are not**, and the
failure mode is a transaction off by 1000×. Write tools therefore take a
decimal amount and convert it in `src/money.ts` — never by hand in a handler, and
never with `amount * 1000`.

**Writes are real.** Creating transactions and updating budgeted amounts mutate
live financial records. There is no sandbox. Treat write tools accordingly:
annotate them, and leave read-only mode able to withhold them.

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
src/index.ts                  entrypoint: reads the environment and argv, connects stdio
src/server.ts                 builds the McpServer and registers the tools it serves
src/client.ts                 the only place `ynab` is imported: auth + plan resolution
src/errors.ts                 maps a failed call to text the model can recover from
src/money.ts                  decimal amounts in, milliunits out, on the write path
src/tools/registry.ts         the tool shape, and the one adapter onto the MCP SDK
src/tools/arguments.ts        arguments more than one tool takes, described once
src/tools/write-arguments.ts  the same, for the arguments only a write takes
src/tools/shapes.ts           the records more than one tool file returns
src/tools/index.ts            every tool the server can serve
src/tools/<tool>.ts           one file per tool, named after it
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

**Plan resolution.** `plan_id` is optional on every tool that acts on a plan, so
handlers that need one call `client.resolvePlanId(planId)`: the explicit
argument, else `YNAB_DEFAULT_PLAN_ID`, else the literal `"last-used"`. That last one is a free
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
`readOnlyHint` is false, but requiring them means no tool can ship without someone
having stated its safety posture in writing.

The spec's own wording fixes the values, and two of its sentences are easy to
misread. `destructiveHint: false` is a claim that the tool "performs only additive
updates", so writing a new amount over a transaction's — or a new `budgeted` over
a month category's — is destructive, and deletes are not the only verb that
qualifies. `idempotentHint` asks whether repeated calls "have no additional effect
on its environment", which is about the environment rather than the response: a
second delete answering 404 is still idempotent, because the world is in the state
the first call left it in.

|                                   | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| --------------------------------- | -------------- | ----------------- | ---------------- |
| reads                             | true           | false             | true             |
| `create_transaction`              | false          | true              | false            |
| other `create_*`                  | false          | false             | false            |
| `update_*`, `set_category_budget` | false          | true              | true             |
| `delete_*`                        | false          | true              | true             |
| `import_transactions`             | false          | true              | false            |

`create_transaction` is the row that makes this a table about what a tool may do
rather than about its verb. Given an `import_id` it does not merely insert: YNAB
matches the new row against an existing user-entered transaction on the same
account, with the same amount, within ten days either way, and the imported
amount wins.

`import_transactions` reaches the same matching from the other side — a Direct
Import is what user-entered rows get matched against — so it is destructive for
the same reason, and it is not idempotent either: a second call imports whatever
the bank delivered in between.

**`openWorldHint` is `false` throughout, on an entity-set reading.** The spec's
only illustration is that "the world of a web search tool is open, whereas that of
a memory tool is not", and these tools sit on the memory side of it: they reach an
external service, but their domain of interaction is closed and enumerable — the
token holder's own plans, accounts, and transactions.

That is a claim about the entities and deliberately not a claim that the payload
is trusted. Rows here carry bank- and merchant-authored payee names and free-text
memos into the model's context, and MCP's own commentary reads `openWorldHint:
true` as flagging a trust boundary being crossed. Both readings are available and
this one is ours: a client hardening against untrusted tool output should not take
the `false` as an assurance about content.

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
next is worse than one worded identically everywhere. `plan_id` appears on nearly
every tool and `month` on most of the read surface, so both live here.

**`plan_id` and `month` arrive already optional; ids do not.** `plan_id` is
optional wherever it appears, and `month` on every tool that has so far taken
one, so baking `.optional()` into those two means no tool can forget it. The two
tools that name no plan at all — `get_user`, whose subject is the token holder,
and `list_plans`, which is where a plan id comes from — take no arguments
whatever. An id is a filter on some tools (`account_id` on `list_transactions`) and the
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
### Plan discovery

`list_plans` is where a model gets a `plan_id`, so its payload stays
proportional to the number of plans rather than to their contents. `getPlans`
takes an `include_accounts` flag, deliberately not exposed: accounts belong to a
single plan and have their own tool, and folding them in would make the call
every session starts with grow with the number of accounts across every plan.
For the same reason the summaries drop the currency and date formats YNAB sends
with them, which `get_plan` reports instead — the read tools pass YNAB's own
formatted amounts through, so nothing else needs a format to interpret a number.
The response's `default_plan` is dropped too: it is populated only for an OAuth
application with default plan selection enabled, which a Personal Access Token
is not. See "The client module".

**`configured_plan_id` answers the question the list raises.** Having seen three
plans, a model still cannot tell which one a call that omits `plan_id` will act
on. The field is that resolved fallback, and it is absent rather than
`"last-used"` when no plan is configured, because the literal is YNAB's
placeholder and not an id the model could pass back.

**`get_plan` makes one request, not two.** ENG-25 asked for a merge of
`getPlanById` and `getPlanSettingsById`, on the understanding that settings adds
a first-day-of-week. It does not: settings returns `date_format` and
`currency_format` and nothing else, and the plan export already carries both.
All a second request would add is that settings declares the two required rather
than optional — and its parser passes a null straight through where the export
maps one to absent, so even that guarantees the key and not a value. That is not
worth one of 200 requests an hour. Should YNAB add a setting later, this is the
tool to fetch it, concurrently with the export.

**The export is paid for on the wire; the counts bound what reaches the model.**
`getPlanById` is a full plan export, and it is the only endpoint that will name
a plan given `"last-used"`, so `get_plan` cannot avoid making it. What it can
avoid is re-serialising accounts, categories, payees, months and every
transaction into the model's context, so each collection is reported as a single
count and left to its own list tool. Those counts are of live records only:
deleted records come back solely on delta requests, which nothing makes yet
(ENG-34).

### Accounts and categories

`list_accounts` and `list_categories` are the lookup tools the write surface
depends on: they turn a name the user said into an id a write tool takes. Each
answers both the whole-plan question and the by-id one, and returns an array
either way, so a caller that already has an id does not meet a second shape.
`categorySchema` and `accountSchema` are exported for the later tools that
return the same records, which is the lifting the "Shared tool arguments"
section defers.

**Categories come back flat.** `getCategories` nests them inside their groups,
which is presentation structure: a model looking for "groceries" has to walk
it, and one row per category naming its group is both smaller and easier to
search. Flattening destroys what the group said about itself, so each row
carries `group_name` and `group_hidden`. A hidden group hides its categories
in YNAB whatever their own `hidden` says, and folding the two into one flag
would state the category's own hiddenness wrongly. The group's `deleted` is
not carried: deleted records only appear in delta requests, which are ENG-34.

**`group_name` is best-effort, and the schema says so.** Only the whole-plan
listing wraps a category in its group. `getCategoryById`,
`getMonthCategoryById` and a month's own category list all return the category
alone, so those three paths fill `group_name` from YNAB's own optional
`category_group_name` when the response carries it, omit it otherwise, and
never carry `group_hidden` at all — resolving either properly would cost a
second request out of 200 an hour for a field the caller usually already has.
Both descriptions qualify on the whole plan being listed rather than on
listing, because the month path is a listing too and carries no group.

**Blank counts as absent for the filter arguments too.** `resolvePlanId`
already trims `plan_id` so that `""` falls through rather than becoming a
request for a plan named `""`; `supplied` in `arguments.ts` applies the same
rule to `account_id`, `category_id` and `month`. A model that fills an
optional filter with the empty string means "no filter", and dispatching the
by-id call on it would ask YNAB for a path with an empty segment, whose
answer is not the listing the model wanted whatever it turns out to be.

**Nothing is filtered.** Hidden categories, closed accounts and YNAB's
internal "Ready to Assign" are all returned, flagged by `hidden`, `closed` and
`internal`. A default filter is invisible to the model, which would then
describe a plan that does not match the one on the user's screen. A flag it
can read is not.

**`month` alone means that month's categories.** ENG-27 paired `month` with
`category_id` and left it undefined on its own; treating it as the current
month would silently ignore an argument the model chose to pass.
`months.getPlanMonth` returns every category priced for the month in a single
request, so all four argument combinations cost one request and `month` means
one thing throughout. What it does not return is the groups, which is the
whole reason the two group columns are qualified the way they are above.

**What is left out.** `deleted` on both models is false in every response we
can ask for. The account debt maps are keyed by month, have no formatted
companion, and mean nothing on a non-loan account. Of the goal surface only
the fields that state a number or a state on their own are exposed —
`goal_cadence`, `goal_cadence_frequency` and `goal_day` need YNAB's cadence
table to read at all, which is not worth carrying down fifty rows of a
listing. Amounts are YNAB's milliunit integer and its `_formatted` string; the
`_currency` decimal is a third spelling of the same number in every row.

**The SDK's model types are reached through `YnabApi`, never imported.**
`Awaited<ReturnType<YnabApi["accounts"]["getAccountById"]>>["data"]["account"]`
is an ugly way to say `Account`, and it is what keeps `src/client.ts` the only
module in the tree that names `ynab`.

### Months and payees

`list_months` answers "how did last month go" — income, assigned, activity and
Ready to Assign — for every month or for one. Naming a `month` routes to
`getPlanMonth`, which returns a `MonthDetail`: the same fields plus that
month's whole category list. **That list is dropped**, so the tool has one
shape either way and a caller asking how a month went is not handed a few
hundred category rows it never asked for — a `months` array that happens to be
one entry long.

Know what that costs, because it is not what it looks like. `MonthDetail`'s
categories are the only place YNAB reports per-month category amounts in bulk:
`getCategories` reports the *current* month whatever month is asked about, and
`getMonthCategoryById` is one request per category, which the hourly limit
cannot absorb across a plan. So a breakdown of how each category did in some
past month is presently answerable nowhere in the read surface, and the tool
descriptions must not send a model to `list_categories` for it. Surfacing them
behind a flag here is the cheap fix when someone wants it — the rows are
already in a response we have paid for.

**Amounts carry the raw milliunits and YNAB's formatted string, and nothing
else.** The API offers a `_currency` decimal beside each one, but it is the
milliunit integer divided by a thousand, and a third spelling of the same
number on every row of a sixty-month list is context paid for twice. That is the
rule for the read surface as a whole rather than a quirk of this tool: no read
tool reports `_currency`. `age_of_money` has no companion at all: it is a count
of days rather than money, and treating it as milliunits would report an Age of
Money in the thousands.

`list_payees` folds payee locations in behind `include_locations` rather than
giving them tools of their own — they are the coordinates the phone app matches
against to guess a payee, real data that nobody asks for by name. The flag is
off by default because it is a second request. With `payee_id` it routes to
`getPayeeLocationsByPayee`; without one it makes exactly one call to
`getPayeeLocations`. Never a call per payee: that is the fan-out the hourly
limit cannot absorb.

**`payee_location_id` is how `getPayeeLocationById` stays reachable.** Location
ids exist nowhere else in the surface — the only way to hold one is to have
listed locations, which returned the payee beside it. So the lookup answers
with that location alone and stays a single request, rather than spending a
second one re-fetching a payee the caller already has. Locations therefore come
back as a top-level list keyed by `payee_id` instead of nested inside each
payee: the same shape then serves the lookup, which has no payee to nest under.
`latitude` and `longitude` stay strings, because that is what YNAB sends.

**Neither tool returns `deleted` or `server_knowledge`.** YNAB sets `deleted`
only on records that come back from a delta request, and we make none until
ENG-34; a field that is `false` on every row of every response is a tax on the
model's context, and once deltas land, reporting what vanished is that layer's
job. A blank `month` or id counts as absent for the reason it does in
`resolvePlanId`: the alternative is asking YNAB for a record named `""`.

### Scheduled transactions and money movements

`list_scheduled_transactions` folds `getScheduledTransactionById` into the list
rather than adding a second tool: passing `scheduled_transaction_id` returns a
one-element `scheduled_transactions` array, so the model reads one shape whichever
way it asked. `frequency` is a `z.string()` naming its thirteen values in
`.describe()` rather than a `z.enum()`, for the same reason ids are bare strings —
YNAB adds values without a major version, and a schema stricter than the API turns
a working read into a tool error.

**Deleted scheduled transactions never arrive.** YNAB returns them only to a
delta request, which nothing here makes yet (ENG-34), so the output description
says they are omitted rather than flagged: a model told they come back marked
`deleted` would read their absence as proof that nothing had been deleted. The
field itself stays in the shape, since it is what deltas will use once ENG-34
lands.

`list_money_movements` covers four endpoints on two independent axes: `month`
picks the `ByMonth` variant, `group_by_movement_group` picks the `Groups` variant,
and both together pick `getMoneyMovementGroupsByMonth`. There is no by-id endpoint
for a movement, so the tool takes no subject id.

**A blank `month` is no month; a blank id is a mistake.** `month` is a filter,
so `""` drops it and the whole plan is listed, the way a blank `plan_id` falls
through in `src/client.ts`. Routing it to the `ByMonth` variant instead would
ask for `/months//money_movements` and answer a perfectly clear request with a
404. A blank `scheduled_transaction_id` is the opposite case: it names the
subject of the call, and widening "this one" into "all of them" answers a
question nobody asked. It goes to YNAB as passed and comes back as a not-found
quoting the empty id, which is the reply that tells the model what it did.

**A group is not a container.** `MoneyMovementGroup` carries only `id`,
`group_created_at`, `month`, `note` and `performed_by_user_id`: no category ids, no
amount, and no nested movements. Grouped and ungrouped answer two different
questions — who moved money and when, against what moved where — rather than a
summary and its detail, which is why the output has a key per shape instead of one
list.

**Resolving category names is a second request, taken deliberately.** A movement
names categories only by id, and an audit trail that needs a second lookup before
anyone can read it does not answer the question it exists for. So the ungrouped
variants fetch the plan's categories once per call, concurrently with the
movements, and join in memory — never a lookup per movement. The second request
is a deliberate exception to the rate-limit rule rather than an oversight, and
not a regression either: a model handed bare ids spends it itself, often more
than once. The grouped variants skip it, having no ids to resolve. The join also
fails loudly rather than degrading, because names missing from some movements and
names missing because the category request failed look identical from the
model's side.

**An unresolved category is silence, not a failure.** Both `from_category_id` and
`to_category_id` are optional — money arriving from Ready to Assign has no
from-category — and an id can name a category the flattened list no longer
carries. Either way the `_name` field is absent and the raw id stays beside it, so
the model can see what it was given. Because the tool resolves to names rather than
returning categories, the shared category shape anticipated above is not needed
here.

**Every row is built field by field, never spread.** Both tools drop YNAB's
`amount_currency` companion, which the read surface reports nowhere: it is the
milliunit integer divided by a thousand, and a third spelling of the same number
on every row of a long list is context paid for twice. Taking it out of the
output schema alone would not have taken it out of the payload. The registry
serialises whatever a handler returns into the text content block before
anything is validated against the schema, so a field the schema does not declare
still reaches the model and still costs the tokens it costs — against a
pass-through, the schema documents the payload rather than deciding it.
`toScheduledTransaction`, `toMoneyMovement` and their two companions name every
field instead, so what the schema promises and what is sent are one list, and a
field YNAB adds later arrives only once someone adds it here. Restoring the
spread would put `amount_currency` back and nothing would fail.
`toMoneyMovementGroup` has no companion field to drop and exists anyway, so the
rule belongs to the tools rather than to the paths that happened to need it.

The mappers name four SDK models through `import type`, which
`verbatimModuleSyntax` erases outright: no module is imported at runtime, and
`src/client.ts` is still the only place the SDK is reached.

### Money on the write path

Every money argument on a write tool is a **decimal amount in the plan's
currency**; `src/money.ts` converts it to milliunits at the handler boundary.
Reads keep passing YNAB's own `_formatted` string through, so nothing on that
side does arithmetic; the `_currency` decimal is dropped throughout the read
surface, for the reason under "Months and payees".

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

### The write surface

`src/tools/write-arguments.ts` is `arguments.ts` for the arguments only a write
takes, and `src/tools/shapes.ts` holds the records more than one tool file
returns. Both exist for the reason `arguments.ts` does: four tools take a
transaction's field set and every write returns a record the read surface already
describes, so left alone the write tools would arrive with five spellings of
`payee_id` and two `transactionSchema`s.

**Input enums are strict; output schemas stay as loose as ever.** The read
surface makes `frequency` a `z.string()` because a schema stricter than YNAB
turns a working read into a tool error. The write path inverts the trade: an
invented value costs one of 200 requests and comes back as an opaque 400, so
rejecting it locally is both cheaper and clearer. These are the same rule seen
from two sides — never let our schema fail a call YNAB would have accepted, and
never spend a request to learn something we already know. So `cleared`,
`frequency` and the creatable account types are `z.enum`s going in and bare
strings coming back.

`flag_color` is the trap. YNAB's enum is the six colours plus `""` plus `null`,
and the empty string and the null are the two documented ways to clear a flag —
a `z.enum` of six colours rejects both. The account types are a growing
allow-list, four in v1.80.0 and two more in v1.82.0 a week later, so that one is
strict with a re-check owed on the next SDK bump (ENG-38).

**The length caps are in the schema because they are nowhere else.** `memo` at
500, a transaction's `payee_name` at 200, `import_id` at 36, a payee's own name
at 500, a category group's at 50. All five are declared in YNAB's OpenAPI spec
(v1.86.0) and dropped by the SDK's generated models, so without them the only way
to find out a memo was too long is to spend a request being told 400.

**`shapes.ts` is a move, not a rewrite.** `transactionSchema`, its subtransaction
shape and `toTransaction` came out of `list-transactions.ts`; the scheduled pair
came out of `list-scheduled-transactions.ts`, where the mapper was not exported at
all. Every field, description and mapper body is unchanged, and `tools/list` is
byte-identical either side of the move — a lift that also edits is a lift nobody
can review. `categorySchema` and `accountSchema` stay where they are: both are
already exported and already imported from their list tools, so moving them would
churn the write branches in flight and buy nothing. When a third tool needs one,
that is when it moves.

**Every write result echoes the plan it acted on**, through `planIdResult()`.
`resolvePlanId` falls back to `"last-used"`, which YNAB resolves per request
against whichever plan was most recently opened in the app. On a read that is
free. On a write, the `list_categories` that found an id and the
`set_category_budget` that spends it can land on different plans — surfacing as a
404 the model reads as a bad id, or, when the id exists in both, as a
correct-looking write to the wrong plan. The handler already holds the resolved
id; echoing it costs nothing, where recovering it afterwards costs a full plan
export.

**`server_knowledge` is dropped, deliberately.** Eleven of the sixteen write
responses carry it, and it is a plan-wide counter and a free delta checkpoint, so
ENG-34 will want it. Nothing reads it today, and a number the model cannot use is
context spent for nothing.

**A 400 on a write leads with YNAB's own `detail`.** It is the only failure most
write endpoints document and it covers a dozen unrelated rules — a date more than
five years out, a future date on a transaction, a split on a tracking account,
editing the lines of a split that already exists, an internal category group, an
over-length memo, an uncreatable account type — which YNAB discriminates nowhere
but in `ErrorDetail.detail`. Read-shaped advice with the detail in a trailing
parenthesis buries the one sentence that says what actually went wrong, so
`writeRejected` in `errors.ts` puts it first. Which branch applies is decided
from `annotations.readOnlyHint`, passed down by the registry, rather than from
the tool's name.

The same pass corrects the 409, which claimed an `import_id` is unique "within a
plan". The spec says the same account — "A transaction on the same account with
the same `import_id` already exists" — and `transactionSchema` already said
account. That was a shipped bug from M2.

Note what none of this reaches. The silent-ignore family — a split's date and
amount changes, a Credit Card Payment `category_id` — comes back 200 with nothing
done, so `errors.ts` never sees it. Only a tool can refuse those, and each write
tool has to.

### Assigning money to a month

`set_category_budget` is the write that gets used daily, and its body is one
field: `SaveMonthCategory` has exactly one property and the SDK's serialiser
emits only that key. A decimal comes in and `toMilliunits` converts it at the
boundary. The 200 hands back the whole ~40-field `Category` for a call that set
one integer, which `categorySchema` trims to the same shape `list_categories`
reports — `toCategory` is exported for it, and fills `group_name` only when YNAB
names the group on the category, which a single-category response usually does
not.

**Replace, not add — and YNAB never actually says so.** Grep the 1.86.0 spec for
"replac" and the only hit is about goal cadence. The shape is what decides it:
`budgeted` carries the same description as the `budgeted` the read surface
reports, there is no delta or increment field anywhere in the API, and the
response echoes the resulting absolute amount. So the tool states the replace
semantics itself, and tells a model that wants "another 50" to read the current
amount and send the total.

**`month` is required here, and checked before a request is spent.** Everywhere
else `monthArgument` bakes in `.optional()`; this tool `.unwrap()`s it so the
wording stays shared while the argument becomes mandatory. Defaulting a
money-moving write to the current month would be a silent choice about where
money lands. The regex then admits only the first of a month or `"current"`,
because whether YNAB coerces a mid-month date to its month, rejects it, or does
something else is undocumented and `CategoriesApi` interpolates the value into
the URL untouched. This is the one argument in the write surface whose wrong
answer is money in the wrong month rather than an error message, so it is a
`.regex()` on the schema — visible in `tools/list` and enforced before the
handler runs — rather than a check in the handler.

**Verifying an assignment is not as easy as it looks.** `getCategories` reports
the *current* month's amounts whatever month was asked about, so `list_categories`
cannot confirm an assignment to any other month, and `list_categories` with a
`category_id` and a `month` routes to `getMonthCategoryById`, whose own YNAB
description contradicts its summary and claims current-month amounts.
`list_categories` with `month` alone routes to `getPlanMonth`, and
`MonthDetail.categories` is the only place in the spec that binds category
amounts to the month asked for. That is the verification path.

**There is no `move_money` tool and there should not be one.** The Money
Movements group is four GETs; a move is two `set_category_budget` calls, lowering
one category and raising another, and it is therefore not atomic. A tool that
hid that would report a success where money can be sitting in Ready to Assign
instead of at its destination, so the tool description says it plainly and leaves
the two calls where the model can watch either fail. Moving money back to Ready
to Assign is a single call, `to_be_budgeted` being derived with no write endpoint
of its own.

**Three things here are still unverified against a live plan** and none of them
can be settled from the spec: whether assigning to a month that does not yet
exist in the plan works, whether `getMonthCategoryById` behaves as its summary
says or as its description does, and whether an API-issued PATCH produces a
`MoneyMovement` row — which decides whether `list_money_movements` can show the
model its own moves. The first is a first-week request ("budget for next month"),
so it is the one to check first.

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
`toMilliunits` is its first user, and the write tools that refuse an argument YNAB
would silently ignore will be the next. Read-only mode is not one of them: it
withholds tools rather than refusing calls, so nothing there ever throws.

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

### Read-only mode

`--read-only`, or `YNAB_READ_ONLY` in the environment, serves the read surface
alone. Write tools are **not registered**, rather than registered and refusing: a
tool the model cannot see is a tool it cannot be talked into trying.

**Filtered before registration, never `disable()`d.** The SDK's `RegisteredTool`
handle can hide a tool from `tools/list`, and it looks equivalent, but it is not.
`McpServer` answers a call to a disabled tool with "Tool `set_category_budget`
disabled" where an unregistered name gets "not found" — the first confirms the
write surface exists and invites the model to ask the user to enable it. A
disabled tool also keeps its handler and closure in `_registeredTools`, one
`update({enabled: true})` away from being reachable again.

**The flag is read in `index.ts`, never in `server.ts`.** `createServer` takes
`{ readOnly }` and reads nothing from the environment itself, which is what keeps
it the seam the test harness builds through (ENG-35). Registration still happens
before `connect`, because `McpServer` registers the tools capability lazily on the
first `registerTool` and throws outright if capabilities appear after a transport
is attached.

**Anything but absent, blank, `0` or `false` turns it on.** That is a deliberate
asymmetry with `resolvePlanId`, where blank falls through to the next fallback.
Here the two failure directions are not equal: reading `YNAB_READ_ONLY=no` as "off"
and serving writes to someone who meant to forbid them is worse than the reverse,
so the setting errs towards being set, and only the spellings that unambiguously
mean "no" turn it off. The flag reads its own value the same way, so
`--read-only=true` and `--read-only` agree.

**A near-miss on the flag stops the process.** Every other argument is rejected
with a `ConfigError`, rather than ignored as an exact-match test would ignore it.
`--read-only=true` is the spelling an MCP client config invites, `--readonly` is
the one a person types, and silently serving the write surface to either is the
failure direction the paragraph above calls the worse one. A server that refuses
to start beats a writable one that starts quietly.

**The mode is announced once, in the handshake, not in every tool.** Two read
descriptions point forward at tools the write surface will add, and in read-only
mode those pointers dangle. Hedging each of them would make the default
configuration read worse to serve the exception, so `instructions` says the server
is read-only and the descriptions stay written for the normal case.

Annotations are the other half of this: their values, and why the spec's wording
decides them, are under "The tool registry". They are a signal to well-behaved
clients and not a boundary — the spec requires clients to treat annotations as
untrusted unless the server itself is trusted, so `--read-only` plus the client's
own confirmation is the actual guard.

**Server-side confirmation is deliberately not built.** Revision `2026-07-28` adds
`InputRequiredResult` for asking mid-call, which could confirm a destructive write
without trusting the client to. The SDK at 1.30.0 implements none of it, and the
one mid-call path it does have — `server.elicitInput()` — is exactly the
server-initiated-request pattern that `2026-07-28` removes as a breaking change.
Building on it now would buy a rewrite at ENG-38 for something the spec already
asks clients to do. Revisit when the SDK ships MRTR.

### Startup

`main()` builds the client *before* connecting the transport, so a missing token
kills the process with a readable reason instead of leaving a server whose every
call 401s.

`ConfigError` prints as a bare message: it is the user's own misconfiguration and
a stack trace would only bury it. Everything else still prints as `fatal:` with
its stack. The startup line on stderr names the resolved default plan, because
that is what a tool call omitting `plan_id` will use, and says so when the server
is read-only.

`createServer` reads nothing from the environment and attaches no transport, so
the test harness (ENG-35) can build a server over an in-memory transport with a
faked `YnabClient`. `index.ts` holds everything that only makes sense in a real
process: reading the environment and the command line, stdio, and exiting
non-zero.
