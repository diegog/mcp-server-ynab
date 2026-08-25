import { z } from "zod";
import { monthArgument, planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";

/** Said on every raw amount, which otherwise reads as a currency amount. */
function inMilliunits(meaning: string): string {
  return `${meaning} In milliunits: 1000 is one unit of the plan's currency.`;
}

/** Said on every formatted amount, so the two are never confused. */
function formattedFor(field: string): string {
  return `\`${field}\` in the plan's own currency format, ready to show to a user.`;
}

const planMonth = z.object({
  month: z.string().describe("The month itself, as its first day: 2016-12-01 is December 2016."),
  note: z
    .string()
    .nullable()
    .optional()
    .describe("The note written on this month in YNAB, if there is one."),
  income: z
    .number()
    .describe(inMilliunits("Money that arrived in the month and landed in Ready to Assign.")),
  income_formatted: z.string().optional().describe(formattedFor("income")),
  budgeted: z.number().describe(inMilliunits("Money assigned to categories in the month.")),
  budgeted_formatted: z.string().optional().describe(formattedFor("budgeted")),
  activity: z
    .number()
    .describe(
      inMilliunits("Everything that moved in the month other than income; spending is negative."),
    ),
  activity_formatted: z.string().optional().describe(formattedFor("activity")),
  to_be_budgeted: z
    .number()
    .describe(inMilliunits("What YNAB shows as Ready to Assign for the month.")),
  to_be_budgeted_formatted: z.string().optional().describe(formattedFor("to_be_budgeted")),
  age_of_money: z
    .number()
    .optional()
    .describe("YNAB's Age of Money as of this month, in days. Not an amount of money."),
});

/** What a month is reported as. Both month endpoints return a superset of it. */
type PlanMonth = z.infer<typeof planMonth>;

/** How a plan's months went, one month or all of them. */
export const listMonths = defineTool({
  name: "list_months",
  title: "List months",
  description:
    "Report how a plan's months went: money in, money assigned, activity, and what was left " +
    "to assign. Covers every month YNAB holds for the plan, or one month when `month` is " +
    "given. These are the month's totals; it reports no breakdown by category.",
  inputSchema: {
    plan_id: planIdArgument(),
    month: monthArgument("Report on this month alone. Omit it to report on every month."),
  },
  outputSchema: {
    months: z
      .array(planMonth)
      .describe(
        "The plan's months, in the order YNAB returns them, or the single month `month` " +
          "named.",
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
    // Blank counts as absent, as it does in `resolvePlanId`.
    const month = args.month?.trim() || undefined;

    if (month === undefined) {
      const { data } = await client.api.months.getPlanMonths(planId);
      return { months: data.months.map(toPlanMonth) };
    }

    const { data } = await client.api.months.getPlanMonth(planId, month);
    return { months: [toPlanMonth(data.month)] };
  },
});

/** Rebuilt field by field: what the API returns besides these is dropped on purpose. */
function toPlanMonth(month: PlanMonth): PlanMonth {
  return {
    month: month.month,
    note: month.note,
    income: month.income,
    income_formatted: month.income_formatted,
    budgeted: month.budgeted,
    budgeted_formatted: month.budgeted_formatted,
    activity: month.activity,
    activity_formatted: month.activity_formatted,
    to_be_budgeted: month.to_be_budgeted,
    to_be_budgeted_formatted: month.to_be_budgeted_formatted,
    age_of_money: month.age_of_money,
  };
}
