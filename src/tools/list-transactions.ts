import { z } from "zod";
import type { YnabClient } from "../client.ts";
import { transactionUri } from "../resources.ts";
import {
  CURRENT_MONTH,
  dateShape,
  idArgument,
  monthArgument,
  planIdArgument,
} from "./arguments.ts";
import { defineTool } from "./registry.ts";
import {
  type Transaction,
  toTransaction,
  transactionSchema,
  type YnabTransaction,
} from "./shapes.ts";

/** The transaction states YNAB can filter on. */
const TYPES = ["uncategorized", "unapproved"] as const;

/**
 * Scope filters in dispatch precedence, each with the endpoint it routes to.
 * The order is load-bearing — see AGENTS.md, "Transaction queries".
 */
const SCOPES = [
  ["category_id", "getTransactionsByCategory"],
  ["payee_id", "getTransactionsByPayee"],
  ["account_id", "getTransactionsByAccount"],
  ["month", "getTransactionsByMonth"],
] as const;

type Scope = (typeof SCOPES)[number][0];
type ScopedMethod = (typeof SCOPES)[number][1];

/** A scope the chosen endpoint could not take, applied to the rows it returns. */
export interface ResidualFilter {
  readonly scope: Scope;
  readonly value: string;
}

/** The filters every query carries, whichever endpoint it lands on. */
interface QueryFilters {
  readonly since_date: string | undefined;
  readonly until_date: string | undefined;
  readonly type: (typeof TYPES)[number] | undefined;
  readonly residual: readonly ResidualFilter[];
}

/** The one call a set of arguments dispatches to, and what it could not express. */
export type TransactionQuery =
  | (QueryFilters & { readonly method: "getTransactions" | "getTransactionsByType" })
  | (QueryFilters & { readonly method: ScopedMethod; readonly scope: string });

/** A transaction reduced to a choice and a pointer at the rest of it. */
const transactionLink = z.object({
  uri: z.string().describe("Read this with `resources/read`, or `get_transaction` by id."),
  id: z.string().describe("Id of the transaction."),
  date: z.string().describe("Date it falls on, as ISO `YYYY-MM-DD`."),
  amount: z.number().describe("Amount in milliunits, where 1000 is one currency unit."),
  amount_formatted: z.string().optional().describe("`amount` in the plan's currency format."),
  payee_name: z.string().optional().describe("Name of the payee, when it has one."),
  category_name: z.string().optional().describe("Name of the category, or `Split`."),
  memo: z.string().optional().describe("Free text on the transaction, when it has any."),
});

/** An ISO date bound. Shaped enough to catch a date that is not one at all. */
function dateArgument(meaning: string, omitted: string): z.ZodOptional<z.ZodString> {
  return dateShape()
    .describe(`${meaning} An ISO date, written as 2026-08-14. ${omitted}`)
    .optional();
}

const inputSchema = {
  plan_id: planIdArgument(),
  account_id: idArgument(
    "Only transactions in this account; omit for every account.",
    "list_accounts",
  ).optional(),
  category_id: idArgument(
    "Only transactions in this category, including the lines of splits assigned to it; omit " +
      "for every category.",
    "list_categories",
  ).optional(),
  payee_id: idArgument(
    "Only transactions with this payee; omit for every payee.",
    "list_payees",
  ).optional(),
  month: monthArgument("Only transactions dated in this plan month; omit for every month."),
  since_date: dateArgument(
    "Only transactions on or after this date.",
    "Omit and YNAB reaches back one year and no further, unless a `month` sets the window.",
  ),
  until_date: dateArgument("Only transactions on or before this date.", "Omit for no upper bound."),
  type: z
    .enum(TYPES)
    .describe(
      "Only transactions in this state: `uncategorized` for those with no category yet, " +
        "`unapproved` for imported ones nobody has approved. Omit for every state.",
    )
    .optional(),
  as_links: z
    .boolean()
    .describe(
      "Return a link and a one-line summary per transaction instead of the full record. Use " +
        "it when the answer needs a sweep rather than the detail — a year of transactions in " +
        "full is a great deal of text — then read the few you care about back by their URI, or " +
        "with `get_transaction`. Off by default.",
    )
    .optional(),
};

/** Everything {@link planQuery} reads. */
export type TransactionQueryArgs = z.infer<z.ZodObject<typeof inputSchema>>;

/**
 * The single endpoint `args` dispatch to, chosen without making a request. See
 * AGENTS.md, "Transaction queries".
 */
export function planQuery(args: TransactionQueryArgs): TransactionQuery {
  const scoped: { method: ScopedMethod; scope: Scope; value: string }[] = [];
  for (const [scope, method] of SCOPES) {
    const value = given(args[scope]);
    if (value !== undefined) scoped.push({ method, scope, value });
  }

  const [narrowest, ...rest] = scoped;
  let since = given(args.since_date);
  let until = given(args.until_date);
  const residual: ResidualFilter[] = [];
  for (const { scope, value } of rest) {
    const bounds = scope === "month" ? monthBounds(value) : undefined;
    if (bounds === undefined) {
      residual.push({ scope, value });
      continue;
    }
    since = since === undefined || bounds.since > since ? bounds.since : since;
    until = until === undefined || bounds.until < until ? bounds.until : until;
  }

  const filters: QueryFilters = {
    since_date: since,
    until_date: until,
    type: args.type,
    residual,
  };
  if (narrowest !== undefined) {
    return { ...filters, method: narrowest.method, scope: narrowest.value };
  }

  // `getTransactionsByType` is `getTransactions` with only a type — see AGENTS.md.
  const onlyType =
    filters.type !== undefined &&
    filters.since_date === undefined &&
    filters.until_date === undefined;
  return { ...filters, method: onlyType ? "getTransactionsByType" : "getTransactions" };
}

/** List transactions, collapsing YNAB's six transaction queries into one. */
export const listTransactions = defineTool({
  name: "list_transactions",
  title: "List transactions",
  description:
    "List transactions in a plan, narrowed by any combination of account, category, payee, " +
    "month, date range and state. Every filter is optional, and with none of them this returns " +
    "the last year of the plan, which is large — narrow it whenever the question allows. " +
    "Filtering by category or payee also returns the individual lines of split transactions, " +
    "which every other filter reports only as one parent whose category reads `Split`.",
  inputSchema,
  outputSchema: {
    transactions: z
      .array(transactionSchema)
      .optional()
      .describe(
        "The matching transactions, newest last, as YNAB ordered them. Absent when `as_links` " +
          "asked for links instead.",
      ),
    transaction_links: z
      .array(transactionLink)
      .optional()
      .describe(
        "One entry per matching transaction: enough to choose between them, and the URI to " +
          "read the rest. Present only when `as_links` asked for them.",
      ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const query = planQuery(args);
    const rows = await fetchRows(client, planId, query);
    const matching = rows.filter(inResidualScope(query.residual)).map(toTransaction);

    if (args.as_links !== true) return { transactions: matching };
    return { transaction_links: matching.map((row) => toLink(planId, row)) };
  },

  /**
   * Resource links in place of the payload. The summary rides in `description`,
   * which is what lets a model pick without reading anything else.
   */
  content(data) {
    if (data.transaction_links === undefined) return undefined;
    return data.transaction_links.map((link) => ({
      type: "resource_link" as const,
      uri: link.uri,
      name: link.id,
      description: summarise(link),
      mimeType: "application/json",
    }));
  },
});

/** Enough of a transaction to choose it, plus where the rest of it lives. */
function toLink(planId: string, row: Transaction): z.infer<typeof transactionLink> {
  return {
    uri: transactionUri(planId, row.id),
    id: row.id,
    date: row.date,
    amount: row.amount,
    ...(row.amount_formatted !== undefined && { amount_formatted: row.amount_formatted }),
    ...(row.payee_name != null && { payee_name: row.payee_name }),
    ...(row.category_name != null && { category_name: row.category_name }),
    ...(row.memo !== undefined && { memo: row.memo }),
  };
}

/** The one line a client shows beside a link. */
function summarise(link: z.infer<typeof transactionLink>): string {
  const parts = [
    link.date,
    link.payee_name ?? "(no payee)",
    link.amount_formatted ?? `${link.amount}`,
  ];
  if (link.category_name !== undefined) parts.push(link.category_name);
  return parts.join(" · ");
}

/** Run `query`, which has already chosen the endpoint. */
async function fetchRows(
  client: YnabClient,
  planId: string,
  query: TransactionQuery,
): Promise<readonly YnabTransaction[]> {
  const api = client.api.transactions;
  const { since_date: since, until_date: until, type } = query;
  switch (query.method) {
    case "getTransactionsByCategory": {
      const page = await api.getTransactionsByCategory(planId, query.scope, since, until, type);
      return page.data.transactions;
    }
    case "getTransactionsByPayee": {
      const page = await api.getTransactionsByPayee(planId, query.scope, since, until, type);
      return page.data.transactions;
    }
    case "getTransactionsByAccount": {
      const page = await api.getTransactionsByAccount(planId, query.scope, since, until, type);
      return page.data.transactions;
    }
    case "getTransactionsByMonth": {
      const page = await api.getTransactionsByMonth(planId, query.scope, since, until, type);
      return page.data.transactions;
    }
    case "getTransactionsByType": {
      const page = await api.getTransactionsByType(planId, type);
      return page.data.transactions;
    }
    case "getTransactions": {
      const page = await api.getTransactions(planId, since, until, type);
      return page.data.transactions;
    }
  }
}

/** The scopes the chosen endpoint could not take, as a test over the rows it returned. */
function inResidualScope(residual: readonly ResidualFilter[]): (row: YnabTransaction) => boolean {
  const tests = residual.map((filter) => {
    if (filter.scope === "month") {
      const prefix = monthPrefix(filter.value);
      return (row: YnabTransaction) => row.date.startsWith(prefix);
    }
    const { scope, value } = filter;
    return (row: YnabTransaction) => row[scope] === value;
  });
  return (row) => tests.every((test) => test(row));
}

/** The `YYYY-MM` a month argument selects, resolving `current` in UTC as YNAB does. */
function monthPrefix(month: string): string {
  return (month === CURRENT_MONTH ? new Date().toISOString() : month).slice(0, 7);
}

/** The first and last day of a plan month, or nothing if it does not read as one. */
function monthBounds(month: string): { since: string; until: string } | undefined {
  const prefix = monthPrefix(month);
  // `Date.UTC` reads a year under 100 as 19xx, so those go to the row filter instead.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(prefix) || prefix.startsWith("00")) return undefined;
  const last = new Date(Date.UTC(Number(prefix.slice(0, 4)), Number(prefix.slice(5)), 0));
  return { since: `${prefix}-01`, until: last.toISOString().slice(0, 10) };
}

/** Blank counts as absent, as it does in `resolvePlanId`. */
function given(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
