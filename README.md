# mcp-server-ynab

An [MCP](https://modelcontextprotocol.io) server wrapping the
[YNAB](https://www.ynab.com) API, so an MCP client can read and change a budget
through tool calls. It runs as a local process over stdio: your Personal Access
Token stays in your own environment and never leaves the machine except in a
request to `api.ynab.com`.

26 tools — 11 that read, 15 that write — covering the API's read surface and all
sixteen of its write operations.

> YNAB renamed "budget" to "plan" in its API, and this server follows the API.
> Every tool takes an optional `plan_id`, and "budget" is used as a verb:
> `set_category_budget` assigns money to a category for a month.

## Install

Requires **Node 20+**. No install step — your MCP client runs it with `npx`.

```json
{
  "mcpServers": {
    "ynab": {
      "command": "npx",
      "args": ["-y", "mcp-server-ynab"],
      "env": { "YNAB_ACCESS_TOKEN": "your-token-here" }
    }
  }
}
```

For read-only access — recommended if you only want to ask questions — add the
flag:

```json
"args": ["-y", "mcp-server-ynab", "--read-only"]
```

### Getting a token

1. Sign in to YNAB and open
   [Account Settings → Developer Settings](https://app.ynab.com/settings/developer).
2. Under **Personal Access Tokens**, choose **New Token**.
3. Copy it into your client configuration as `YNAB_ACCESS_TOKEN`. YNAB shows it
   once.

## Security

Worth being plain about, because pointing a language model at your finances
deserves more than a shrug:

- **The token grants full read and write access to every budget on your YNAB
  account.** YNAB Personal Access Tokens carry no scopes — there is no read-only
  token to issue. `--read-only` is enforced by this server, not by YNAB.
- **The token stays in your environment.** It is read once at startup, handed
  straight to the YNAB SDK, and never stored on any object, logged, or included
  in an error message.
- **The server makes no outbound request to anything but `api.ynab.com`.** No
  telemetry, no analytics, no update check.
- **Nothing is written to disk.** The cache is in memory and dies with the
  process.
- **Writes are real and there is no sandbox.** YNAB has no test mode, so a tool
  call that creates a transaction creates a real transaction.

### Read-only mode

`--read-only`, or `YNAB_READ_ONLY=1`, serves only the 11 read tools. The write
tools are **not registered at all** rather than registered and refusing, so the
model cannot see them and cannot ask you to turn them on. A call to one by name
answers "not found".

If you want an assistant that answers questions about your budget without ever
changing it, use this. It is the only guard that does not depend on the model
behaving.

## Tools

Every tool takes an optional `plan_id`. Omit it and the server uses
`YNAB_DEFAULT_PLAN_ID` if set, otherwise the plan most recently opened in YNAB.
Get ids from `list_plans`.

### Reading

| Tool | |
| -- | -- |
| `list_plans` | Every plan on the account, and which one the server defaults to |
| `get_plan` | One plan's settings and record counts |
| `get_user` | The authenticated user's id |
| `list_accounts` | Accounts and balances, or one by id |
| `list_categories` | Categories flattened out of their groups, with what is assigned, spent and available |
| `list_months` | How each month went: income, assigned, activity, Ready to Assign |
| `list_payees` | Payees, and their saved locations on request |
| `list_transactions` | One query over six endpoints — filter by account, category, payee, month, date range or state |
| `get_transaction` | One transaction by id, split lines included |
| `list_scheduled_transactions` | Standing instructions YNAB will enter on a future date |
| `list_money_movements` | The audit trail of money moved between categories |

### Writing

| Tool | |
| -- | -- |
| `create_transaction` | Record one transaction or many, including splits and transfers |
| `update_transaction` | Change existing transactions, addressed by id or `import_id` |
| `delete_transaction` | Delete a transaction |
| `import_transactions` | Pull new transactions from every linked bank account |
| `set_category_budget` | Assign money to a category for a month |
| `create_category` / `update_category` | Add a category or change its name, group or target |
| `create_category_group` / `update_category_group` | Add or rename a category group |
| `create_account` | Add an account |
| `create_payee` / `update_payee` | Add or rename a payee |
| `create_scheduled_transaction` | Schedule a future transaction, optionally repeating |
| `update_scheduled_transaction` | Replace a scheduled transaction |
| `delete_scheduled_transaction` | Cancel a scheduled transaction |

Every write tool carries MCP's behaviour annotations, so a client that surfaces
them can warn you before a destructive call. Treat those as a hint to a
well-behaved client rather than a security boundary — `--read-only` is the real
guard.

## What the API cannot do

These are YNAB's limits, not omissions here. Worth knowing before you ask for
them:

- **An account cannot be renamed, closed or deleted** through the API. There is
  only a create. A mistake has to be fixed in the YNAB app, which is why
  `create_account` asks you to confirm before it acts.
- **A category or category group cannot be deleted or hidden.** Renaming a group
  and re-filing a category is the whole extent of the control there is. A
  `delete_category` tool cannot be built.
- **A split transaction cannot be edited.** No endpoint adds, changes or removes
  a line, and a split's category cannot be changed. Delete it and create it
  again.
- **There is no payee delete**, and no way to merge two payees deliberately.
- **Moving money between categories is two calls, and is not atomic.** There is
  no money-movement write endpoint, so a move lowers one category and raises
  another. If the second call fails the money sits in Ready to Assign rather than
  back where it started.
- **Recurring "NEED" target frequencies cannot be set.** The field exists in
  YNAB's current spec but not in the vendored SDK, which drops it silently.

## Rate limit

YNAB allows **200 requests per hour per token**, over a rolling window rather
than resetting on the hour. That is not much for an agent exploring a budget, so
the server caches reads in memory: a repeated read costs nothing, and a write
clears the cached reads for that plan so nothing stale is served afterwards.

`YNAB_CACHE_TTL_SECONDS` sets the freshness window, default 60. Set it to `0` to
send every read to YNAB, which the limit rarely affords.

If you do hit the limit, the server says so in terms the model can act on —
including that retrying immediately cannot work.

## Configuration

| Variable | |
| -- | -- |
| `YNAB_ACCESS_TOKEN` | **Required.** Your Personal Access Token |
| `YNAB_DEFAULT_PLAN_ID` | Plan to act on when a tool omits `plan_id`. Defaults to the last plan opened in YNAB |
| `YNAB_READ_ONLY` | Anything but blank, `0` or `false` serves the read tools alone |
| `YNAB_CACHE_TTL_SECONDS` | How long a read stays fresh. Default `60`, `0` disables |

The `--read-only` flag does the same as `YNAB_READ_ONLY`. Any other argument
stops the server with an explanation rather than being ignored.

## Development

Requires Node 26+, which runs TypeScript directly — there is no build step for
local work.

```bash
npm install
cp .env.example .env   # then add your Personal Access Token
npm run dev            # start the server on stdio
npm test               # node --test, no network
npm run check          # lint + typecheck + test
```

See [AGENTS.md](AGENTS.md) for the architecture, the conventions, and the
reasoning behind the decisions that shape this codebase — including the ones that
went against the obvious choice.

## License

MIT © Diego Garcia
