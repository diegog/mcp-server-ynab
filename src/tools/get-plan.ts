import { z } from "zod";
import { planIdArgument } from "./arguments.ts";
import { planFields, toPlanFields } from "./list-plans.ts";
import { defineTool } from "./registry.ts";

/** How the plan writes money. Every amount in the plan is in this currency. */
const currencyFormat = z.object({
  iso_code: z.string().describe("ISO 4217 code of the plan's currency, such as USD."),
  currency_symbol: z.string().describe("Symbol for that currency, such as $."),
  display_symbol: z.boolean().describe("Whether the user chose to show the symbol at all."),
  symbol_first: z
    .boolean()
    .describe("Whether the symbol goes before the amount rather than after."),
  decimal_digits: z
    .number()
    .describe("Decimal digits the currency uses: 2 for USD, 3 for KWD, 0 for JPY."),
  decimal_separator: z.string().describe("Character between the whole part and the decimals."),
  group_separator: z.string().describe("Character separating groups of thousands."),
  example_format: z.string().describe("An amount laid out the way this plan writes one."),
});

/** How the plan shows dates. The API itself is unaffected by it. */
const dateFormat = z.object({
  format: z
    .string()
    .describe(
      "Pattern the user reads dates in, such as MM/DD/YYYY or DD.MM.YYYY. Presentation only: " +
        "dates sent to and returned by these tools are always ISO, as in 2016-12-01.",
    ),
});

/** How much the plan holds of each thing that has its own tool. */
const counts = z.object({
  accounts: z.number().int().describe("Accounts, closed ones included."),
  category_groups: z
    .number()
    .int()
    .describe("Category groups, including hidden ones and YNAB's own internal group."),
  categories: z.number().int().describe("Categories across every group, hidden ones included."),
  payees: z
    .number()
    .int()
    .describe("Payees, including the transfer payee YNAB keeps for each account."),
  payee_locations: z.number().int().describe("Payee locations, which YNAB's mobile apps record."),
  months: z.number().int().describe("Plan months on record, one per month the plan covers."),
  transactions: z
    .number()
    .int()
    .describe("Transactions in the whole plan; a split counts once, not once per split line."),
  scheduled_transactions: z
    .number()
    .int()
    .describe("Scheduled transactions, counted as templates rather than future occurrences."),
});

/**
 * One plan, with the formats needed to read everything else in it.
 * @see https://api.ynab.com/#endpoints
 */
export const getPlan = defineTool({
  name: "get_plan",
  title: "Get plan",
  description:
    "Get one plan (also called a budget), with the currency its amounts are in and the date " +
    "format its user reads. Also reports how many accounts, categories, payees and " +
    "transactions the plan holds, but none of the records themselves — each of those has its " +
    "own tool, so the reply stays small. YNAB assembles the whole plan to answer this, " +
    "though, so call it once for a plan rather than repeatedly.",
  inputSchema: {
    plan_id: planIdArgument(),
  },
  outputSchema: {
    plan: z
      .object({
        ...planFields,
        currency_format: currencyFormat
          .describe(
            "How to read every amount in this plan. Absent when YNAB holds no format for the " +
              "plan; amounts elsewhere still come with a formatted string alongside them.",
          )
          .optional(),
        date_format: dateFormat
          .describe("How this user reads dates. Absent when YNAB holds no format for the plan.")
          .optional(),
        counts: counts.describe("How much the plan holds, by kind of record."),
      })
      .describe("The plan itself, without any of the records it holds."),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const { data } = await client.api.plans.getPlanById(client.resolvePlanId(args.plan_id));
    const { plan } = data;
    return {
      plan: {
        ...toPlanFields(plan),
        currency_format: plan.currency_format,
        date_format: plan.date_format,
        // Deleted records reach us only on a delta request, which nothing makes yet.
        counts: {
          accounts: plan.accounts?.length ?? 0,
          category_groups: plan.category_groups?.length ?? 0,
          categories: plan.categories?.length ?? 0,
          payees: plan.payees?.length ?? 0,
          payee_locations: plan.payee_locations?.length ?? 0,
          months: plan.months?.length ?? 0,
          transactions: plan.transactions?.length ?? 0,
          scheduled_transactions: plan.scheduled_transactions?.length ?? 0,
        },
      },
    };
  },
});
