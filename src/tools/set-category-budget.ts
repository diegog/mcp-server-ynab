import { moneyArgument, toMilliunits } from "../money.ts";
import { idArgument, monthArgument, planIdArgument } from "./arguments.ts";
import { categorySchema, toCategory } from "./list-categories.ts";
import { defineTool } from "./registry.ts";
import { planIdResult } from "./shapes.ts";

/**
 * The months this endpoint takes: the first of a month, or the literal for the
 * current one. Checked here rather than sent — see AGENTS.md, "Assigning money".
 */
const BUDGET_MONTH = /^(?:current|\d{4}-(?:0[1-9]|1[0-2])-01)$/;

/** Assign an amount to one category for one month. */
export const setCategoryBudget = defineTool({
  name: "set_category_budget",
  title: "Budget money to a category",
  description:
    "Assign an amount to a category for a month — the everyday act of budgeting in YNAB. The " +
    "amount **replaces** whatever was assigned to that category for that month; it is not " +
    "added to it, so to give a category another 50 read its current `budgeted` with " +
    "`list_categories` and send the total. Assigning less than a category already holds " +
    "returns the difference to Ready to Assign. Moving money between two categories is two " +
    "calls, one lowering the source and one raising the destination, and nothing makes them " +
    "atomic: if the second fails the money sits in Ready to Assign rather than back where it " +
    "started, so say so rather than assuming the move completed.",
  inputSchema: {
    plan_id: planIdArgument(),
    month: monthArgument("The month to assign the money in.")
      .unwrap()
      .regex(
        BUDGET_MONTH,
        'A month here is the first day of that month, as 2026-08-01, or the literal "current". ' +
          "A date mid-month is refused rather than guessed at.",
      ),
    category_id: idArgument("The category to assign the money to.", "list_categories"),
    amount: moneyArgument(
      "The amount the category should have assigned for the month once this call is done.",
    ),
  },
  outputSchema: {
    plan_id: planIdResult(),
    category: categorySchema.describe(
      "The category as it stands after the assignment, with the month's `budgeted`, `activity` " +
        "and `balance`. `group_name` is present only when YNAB names the group on the category " +
        "itself, and `group_hidden` never is: no single-category response carries the group.",
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const { data } = await client.api.categories.updateMonthCategory(
      planId,
      args.month,
      args.category_id,
      { category: { budgeted: toMilliunits(args.amount, "amount") } },
    );
    return { plan_id: planId, category: toCategory(data.category) };
  },
});
