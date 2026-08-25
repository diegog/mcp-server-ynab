import type { HybridTransaction, TransactionDetail } from "ynab";
import { z } from "zod";
import type { YnabClient } from "../client.ts";
import { CURRENT_MONTH, idArgument, monthArgument, planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";

/** A row of any transaction query: YNAB returns two shapes and this is either. */
type YnabTransaction = TransactionDetail | HybridTransaction;

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

/** One line of a split transaction. */
const subtransactionSchema = z.object({
  id: z.string().describe("Id of this line."),
  amount: z
    .number()
    .describe("Amount in milliunits, where 1000 is one currency unit. Outflows are negative."),
  amount_formatted: z.string().optional().describe("`amount` in the plan's currency format."),
  memo: z.string().optional().describe("Free text on this line."),
  payee_id: z.string().optional().describe("Payee of this line, when it differs from the parent."),
  payee_name: z.string().nullable().optional().describe("Name of that payee."),
  category_id: z.string().optional().describe("Category this line is assigned to."),
  category_name: z.string().nullable().optional().describe("Name of that category."),
  transfer_account_id: z.string().optional().describe("If this line is a transfer, its account."),
  transfer_transaction_id: z
    .string()
    .optional()
    .describe("If this line is a transfer, the transaction on the other side."),
  deleted: z.boolean().optional().describe("Present and true only if this line was deleted."),
});

/** A transaction, in the one shape every transaction query here reports. */
export const transactionSchema = z.object({
  id: z.string().describe("Id of the transaction."),
  date: z.string().describe("Date the transaction falls on, as ISO `YYYY-MM-DD`."),
  amount: z
    .number()
    .describe(
      "Amount in milliunits, where 1000 is one currency unit. Outflows are negative and " +
        "inflows positive.",
    ),
  amount_formatted: z
    .string()
    .optional()
    .describe("`amount` in the plan's currency format, ready to show the user."),
  memo: z.string().optional().describe("Free text on the transaction."),
  cleared: z
    .string()
    .describe(
      "Whether the transaction has cleared the account: `cleared`, `uncleared` or `reconciled`.",
    ),
  approved: z
    .boolean()
    .describe("Whether the transaction is approved. Imported transactions start unapproved."),
  flag_color: z
    .string()
    .nullable()
    .optional()
    .describe("Flag on the transaction: `red`, `orange`, `yellow`, `green`, `blue` or `purple`."),
  flag_name: z.string().optional().describe("The plan's own name for that flag colour."),
  account_id: z.string().describe("Account the transaction is in."),
  account_name: z.string().describe("Name of that account."),
  payee_id: z.string().optional().describe("Payee of the transaction."),
  payee_name: z.string().nullable().optional().describe("Name of that payee."),
  category_id: z
    .string()
    .optional()
    .describe("Category of the transaction. Absent on a transfer, and on a split."),
  category_name: z
    .string()
    .nullable()
    .optional()
    .describe("Name of that category, or `Split` when the categories are on the lines below."),
  transfer_account_id: z.string().optional().describe("If a transfer, the account money moved to."),
  transfer_transaction_id: z
    .string()
    .optional()
    .describe("If a transfer, the transaction on the other side of it."),
  matched_transaction_id: z
    .string()
    .optional()
    .describe("The imported transaction this one was matched against, if any."),
  import_id: z
    .string()
    .optional()
    .describe(
      "Id the transaction was imported under, unique within its account. Absent when it was " +
        "entered by hand.",
    ),
  debt_transaction_type: z
    .string()
    .nullable()
    .optional()
    .describe(
      "On a debt or loan account, what the transaction does: `payment`, `refund`, `fee`, " +
        "`interest`, `escrow`, `balanceAdjustment`, `credit` or `charge`.",
    ),
  deleted: z.boolean().optional().describe("Present and true only if the transaction was deleted."),
  type: z
    .string()
    .optional()
    .describe(
      "`transaction` or `subtransaction`. Present only when filtering by category or payee, " +
        "which return the lines of a split as rows in their own right.",
    ),
  parent_transaction_id: z
    .string()
    .nullable()
    .optional()
    .describe("On a `subtransaction` row, the split transaction the line belongs to."),
  subtransactions: z
    .array(subtransactionSchema)
    .optional()
    .describe(
      "The lines of a split transaction, empty when it is not a split. Absent when filtering " +
        "by category or payee.",
    ),
});

/** A transaction as this server reports it. */
export type Transaction = z.infer<typeof transactionSchema>;

/** An ISO date bound. Shaped enough to catch a date that is not one at all. */
function dateArgument(meaning: string, omitted: string): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are ISO `YYYY-MM-DD`, as in 2026-08-14.")
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
      .describe("The matching transactions, newest last, as YNAB ordered them."),
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
    return { transactions: rows.filter(inResidualScope(query.residual)).map(toTransaction) };
  },
});

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

/** One row of either response shape, as this server reports it. */
export function toTransaction(row: YnabTransaction): Transaction {
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    amount_formatted: row.amount_formatted,
    memo: row.memo,
    cleared: row.cleared,
    approved: row.approved,
    flag_color: row.flag_color,
    flag_name: row.flag_name,
    account_id: row.account_id,
    account_name: row.account_name,
    payee_id: row.payee_id,
    payee_name: row.payee_name,
    category_id: row.category_id,
    category_name: row.category_name,
    transfer_account_id: row.transfer_account_id,
    transfer_transaction_id: row.transfer_transaction_id,
    matched_transaction_id: row.matched_transaction_id,
    import_id: row.import_id,
    debt_transaction_type: row.debt_transaction_type,
    type: "type" in row ? row.type : undefined,
    parent_transaction_id: "parent_transaction_id" in row ? row.parent_transaction_id : undefined,
    subtransactions:
      "subtransactions" in row ? row.subtransactions.map(toSubtransaction) : undefined,
    ...(row.deleted ? { deleted: true } : {}),
  };
}

/** One line of a split, dropping the parent id it is already nested under. */
function toSubtransaction(line: TransactionDetail["subtransactions"][number]) {
  return {
    id: line.id,
    amount: line.amount,
    amount_formatted: line.amount_formatted,
    memo: line.memo,
    payee_id: line.payee_id,
    payee_name: line.payee_name,
    category_id: line.category_id,
    category_name: line.category_name,
    transfer_account_id: line.transfer_account_id,
    transfer_transaction_id: line.transfer_transaction_id,
    ...(line.deleted ? { deleted: true } : {}),
  };
}

/** Blank counts as absent, as it does in `resolvePlanId`. */
function given(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
