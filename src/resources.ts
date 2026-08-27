/**
 * A second read surface over the same handlers. See AGENTS.md, "The resource
 * layer" — resources are application-driven, so this is a bonus path rather
 * than the primary one, and every entry runs a tool that already exists.
 */
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnyToolDefinition, ToolContext } from "./tools/registry.ts";

/** The scheme every resource here lives under. */
export const SCHEME = "ynab://";

/** Template variables, as the SDK hands them over. */
type Variables = Record<string, string | string[]>;

/** One resource: a URI, the tool that answers it, and the arguments to run it with. */
interface Entry {
  readonly uri: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly tool: string;
  args(variables: Variables): Record<string, unknown>;
}

/** The first value of a template variable, which is all any of these take. */
function one(variables: Variables, key: string): string {
  const value = variables[key];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const plan = (variables: Variables) => ({ plan_id: one(variables, "plan") });

/**
 * The URI space. `settings` is deliberately absent: YNAB's settings endpoint
 * returns the date and currency formats the plan export already carries, so a
 * second URI would be a second name for the same bytes (see "Plan discovery").
 * There is no bare `transactions` list either — it is the one collection large
 * enough that handing back a URI per row is the point, which is what
 * `list_transactions`' own `as_links` does.
 */
const ENTRIES: readonly Entry[] = [
  {
    uri: "ynab://user",
    name: "user",
    title: "Authenticated user",
    description: "The user whose token this server holds.",
    tool: "get_user",
    args: () => ({}),
  },
  {
    uri: "ynab://plans",
    name: "plans",
    title: "Plans",
    description: "Every plan on the account, and which one this server acts on by default.",
    tool: "list_plans",
    args: () => ({}),
  },
  {
    uri: "ynab://plans/{plan}",
    name: "plan",
    title: "Plan",
    description: "One plan's settings and record counts.",
    tool: "get_plan",
    args: plan,
  },
  {
    uri: "ynab://plans/{plan}/accounts",
    name: "accounts",
    title: "Accounts",
    description: "The plan's accounts and their balances.",
    tool: "list_accounts",
    args: plan,
  },
  {
    uri: "ynab://plans/{plan}/accounts/{id}",
    name: "account",
    title: "Account",
    description: "One account and its balances.",
    tool: "list_accounts",
    args: (v) => ({ ...plan(v), account_id: one(v, "id") }),
  },
  {
    uri: "ynab://plans/{plan}/categories",
    name: "categories",
    title: "Categories",
    description: "The plan's categories, flattened out of their groups.",
    tool: "list_categories",
    args: plan,
  },
  {
    uri: "ynab://plans/{plan}/categories/{id}",
    name: "category",
    title: "Category",
    description: "One category, with what is assigned, spent and available.",
    tool: "list_categories",
    args: (v) => ({ ...plan(v), category_id: one(v, "id") }),
  },
  {
    uri: "ynab://plans/{plan}/months",
    name: "months",
    title: "Months",
    description: "How each month went: income, assigned, activity, Ready to Assign.",
    tool: "list_months",
    args: plan,
  },
  {
    uri: "ynab://plans/{plan}/months/{month}",
    name: "month",
    title: "Month",
    description: "How one month went.",
    tool: "list_months",
    args: (v) => ({ ...plan(v), month: one(v, "month") }),
  },
  {
    uri: "ynab://plans/{plan}/months/{month}/categories/{id}",
    name: "month-category",
    title: "Category in a month",
    description: "One category's amounts as they stood in a given month.",
    tool: "list_categories",
    args: (v) => ({ ...plan(v), month: one(v, "month"), category_id: one(v, "id") }),
  },
  {
    uri: "ynab://plans/{plan}/transactions/{id}",
    name: "transaction",
    title: "Transaction",
    description: "One transaction in full, split lines included.",
    tool: "get_transaction",
    args: (v) => ({ ...plan(v), transaction_id: one(v, "id") }),
  },
  {
    uri: "ynab://plans/{plan}/payees",
    name: "payees",
    title: "Payees",
    description: "The plan's payees.",
    tool: "list_payees",
    args: plan,
  },
  {
    uri: "ynab://plans/{plan}/payees/{id}",
    name: "payee",
    title: "Payee",
    description: "One payee.",
    tool: "list_payees",
    args: (v) => ({ ...plan(v), payee_id: one(v, "id") }),
  },
  {
    uri: "ynab://plans/{plan}/payees/{id}/locations",
    name: "payee-locations-for-payee",
    title: "Locations of a payee",
    description: "The saved locations belonging to one payee.",
    tool: "list_payees",
    args: (v) => ({ ...plan(v), payee_id: one(v, "id"), include_locations: true }),
  },
  {
    uri: "ynab://plans/{plan}/payee-locations",
    name: "payee-locations",
    title: "Payee locations",
    description: "Every saved payee location in the plan.",
    tool: "list_payees",
    args: (v) => ({ ...plan(v), include_locations: true }),
  },
  {
    uri: "ynab://plans/{plan}/payee-locations/{id}",
    name: "payee-location",
    title: "Payee location",
    description: "One saved location, by its own id.",
    tool: "list_payees",
    args: (v) => ({ ...plan(v), payee_location_id: one(v, "id") }),
  },
  {
    uri: "ynab://plans/{plan}/scheduled-transactions",
    name: "scheduled-transactions",
    title: "Scheduled transactions",
    description: "Standing instructions YNAB will enter on a future date.",
    tool: "list_scheduled_transactions",
    args: plan,
  },
  {
    uri: "ynab://plans/{plan}/scheduled-transactions/{id}",
    name: "scheduled-transaction",
    title: "Scheduled transaction",
    description: "One scheduled transaction.",
    tool: "list_scheduled_transactions",
    args: (v) => ({ ...plan(v), scheduled_transaction_id: one(v, "id") }),
  },
  {
    uri: "ynab://plans/{plan}/money-movements",
    name: "money-movements",
    title: "Money movements",
    description: "The audit trail of money moved between categories.",
    tool: "list_money_movements",
    args: plan,
  },
  {
    uri: "ynab://plans/{plan}/money-movements/{month}",
    name: "money-movements-in-month",
    title: "Money movements in a month",
    description: "Money moved between categories in one month.",
    tool: "list_money_movements",
    args: (v) => ({ ...plan(v), month: one(v, "month") }),
  },
  {
    uri: "ynab://plans/{plan}/money-movement-groups",
    name: "money-movement-groups",
    title: "Money movement groups",
    description: "Who moved money and when, rather than what moved where.",
    tool: "list_money_movements",
    args: (v) => ({ ...plan(v), group_by_movement_group: true }),
  },
  {
    uri: "ynab://plans/{plan}/money-movement-groups/{month}",
    name: "money-movement-groups-in-month",
    title: "Money movement groups in a month",
    description: "Who moved money in one month.",
    tool: "list_money_movements",
    args: (v) => ({ ...plan(v), month: one(v, "month"), group_by_movement_group: true }),
  },
];

/** The URI of one transaction, which `list_transactions` hands back as a link. */
export function transactionUri(planId: string, transactionId: string): string {
  return `ynab://plans/${encodeURIComponent(planId)}/transactions/${encodeURIComponent(transactionId)}`;
}

/**
 * Register the read surface a second time, as resources. Only read tools appear:
 * a resource is a thing to look at, and `resources/read` has no notion of a call
 * that changes something.
 */
export function registerResources(
  server: McpServer,
  tools: readonly AnyToolDefinition[],
  context: ToolContext,
): void {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const entry of ENTRIES) {
    const tool = byName.get(entry.tool);
    // A resource whose tool is not being served — read-only mode never withholds
    // one, but a future filter might — is simply not registered.
    if (tool === undefined) continue;

    const metadata = {
      title: entry.title,
      description: entry.description,
      mimeType: "application/json",
    };

    const read = async (uri: URL, variables: Variables): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await tool.handler(entry.args(variables), context)),
        },
      ],
    });

    if (entry.uri.includes("{")) {
      // `list: undefined` on purpose: enumerating these means spending requests
      // out of 200 an hour on a listing nobody asked for. They are discoverable
      // through `resources/templates/list`.
      server.registerResource(
        entry.name,
        new ResourceTemplate(entry.uri, { list: undefined }),
        metadata,
        read,
      );
    } else {
      server.registerResource(entry.name, entry.uri, metadata, async (uri) => read(uri, {}));
    }
  }
}
