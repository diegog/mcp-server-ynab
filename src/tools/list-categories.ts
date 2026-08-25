import { z } from "zod";
import type { YnabApi } from "../client.ts";
import { idArgument, monthArgument, planIdArgument, supplied } from "./arguments.ts";
import { defineTool } from "./registry.ts";

/** The SDK's category model, reached without importing `ynab`. See AGENTS.md. */
type YnabCategory = Awaited<
  ReturnType<YnabApi["categories"]["getCategoryById"]>
>["data"]["category"];

/** The SDK's category group, which only the whole-plan listing returns. */
type YnabCategoryGroup = Awaited<
  ReturnType<YnabApi["categories"]["getCategories"]>
>["data"]["category_groups"][number];

/** One category, lifted out of its group. See AGENTS.md, "Accounts and categories". */
export const categorySchema = z.object({
  id: z.string().describe("Category id, opaque. Pass it to the tools that take a category."),
  name: z.string().describe('Category name as it appears in YNAB, e.g. "Groceries".'),
  category_group_id: z.string().describe("Id of the group this category sits in."),
  group_name: z
    .string()
    .optional()
    .describe(
      'Name of the group this category sits in, e.g. "Immediate Obligations". Always present ' +
        "when the whole plan is listed, which is the only response that wraps a category in " +
        "its group; when month or category_id narrows the call, only when YNAB itself names " +
        "the group on the category.",
    ),
  group_hidden: z
    .boolean()
    .optional()
    .describe(
      "Whether the group is hidden, which hides its categories in YNAB whatever their own " +
        "`hidden` says. Present only when the whole plan is listed: no response narrowed by " +
        "month or category_id carries the group itself.",
    ),
  hidden: z
    .boolean()
    .describe("Whether the category itself is hidden in YNAB. Hidden categories are still listed."),
  internal: z
    .boolean()
    .describe(
      'True for YNAB\'s own built-in categories, of which "Ready to Assign" — money received ' +
        "but not yet assigned anywhere — is the one that matters. They are listed like any " +
        "other category rather than filtered out.",
    ),
  note: z.string().optional().describe("Free-text note on the category, when it has one."),
  budgeted: z
    .number()
    .describe(
      "Amount assigned to the category for the month, in milliunits, where 1000 is one " +
        "currency unit.",
    ),
  budgeted_formatted: z
    .string()
    .optional()
    .describe('The assigned amount in the plan\'s currency format, e.g. "$1,234.56".'),
  activity: z
    .number()
    .describe(
      "Sum of the month's transactions in the category, in milliunits; spending is negative.",
    ),
  activity_formatted: z
    .string()
    .optional()
    .describe("The month's activity in the plan's currency format."),
  balance: z
    .number()
    .describe(
      "Amount still available to spend in the category, in milliunits: what is assigned plus " +
        "what rolled over, less the activity.",
    ),
  balance_formatted: z
    .string()
    .optional()
    .describe("The available balance in the plan's currency format."),
  goal_type: z
    .string()
    .nullable()
    .optional()
    .describe(
      "The kind of target set on the category, if any: TB (target balance), TBD (target " +
        "balance by date), MF (monthly funding), NEED (plan your spending) or DEBT (debt " +
        "payoff). Absent when the category has no target; YNAB adds kinds without warning.",
    ),
  goal_target: z.number().optional().describe("The target amount, in milliunits."),
  goal_target_formatted: z
    .string()
    .nullable()
    .optional()
    .describe("The target amount in the plan's currency format."),
  goal_target_date: z
    .string()
    .optional()
    .describe("Date the target is meant to be met, for the kinds of target that set one."),
  goal_percentage_complete: z
    .number()
    .optional()
    .describe("How far the target has been met, 0 to 100."),
  goal_under_funded: z
    .number()
    .optional()
    .describe(
      "Still to assign this month to stay on track for the target, in milliunits. Zero when " +
        "the category is on track.",
    ),
  goal_under_funded_formatted: z
    .string()
    .nullable()
    .optional()
    .describe("The amount still to assign, in the plan's currency format."),
});

/**
 * A plan's categories, flattened out of their groups, or one of them.
 * @see https://api.ynab.com/v1
 */
export const listCategories = defineTool({
  name: "list_categories",
  title: "List categories",
  description:
    "List a plan's categories with what is assigned, spent and available in each. This is how a " +
    'name like "Groceries" becomes the id the transaction and budgeting tools take. Categories ' +
    "come back flat, each naming the group it belongs to, rather than nested inside their " +
    "groups. Pass category_id for one category, month to report the amounts as of that month, " +
    "or both; either narrowing costs the group columns, dropping group_hidden and leaving " +
    "group_name to whether YNAB names the group on the category. Hidden categories and YNAB's " +
    'own "Ready to Assign" are included.',
  inputSchema: {
    plan_id: planIdArgument(),
    category_id: idArgument(
      "Return only this category instead of all of them.",
      "list_categories",
    ).optional(),
    month: monthArgument(
      "Report the amounts as they stand in this month. Omit it for the current month.",
    ),
  },
  outputSchema: {
    categories: z
      .array(categorySchema)
      .describe(
        "The plan's categories in YNAB's own order, or the single one that was asked for. " +
          "Amounts are those of the requested month, or of the current plan month in UTC when " +
          "no month was given.",
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
    const categoryId = supplied(args.category_id);
    const month = supplied(args.month);

    if (categoryId !== undefined) {
      const { data } =
        month === undefined
          ? await client.api.categories.getCategoryById(planId, categoryId)
          : await client.api.categories.getMonthCategoryById(planId, month, categoryId);
      return { categories: [toCategory(data.category)] };
    }

    if (month !== undefined) {
      // A month carries its own copy of every category, but not their groups. See AGENTS.md.
      const { data } = await client.api.months.getPlanMonth(planId, month);
      return { categories: data.month.categories.map((category) => toCategory(category)) };
    }

    const { data } = await client.api.categories.getCategories(planId);
    return {
      categories: data.category_groups.flatMap((group) =>
        group.categories.map((category) => toCategory(category, group)),
      ),
    };
  },
});

/** `group` is the enclosing group, which only the whole-plan listing has to give. */
function toCategory(
  category: YnabCategory,
  group?: YnabCategoryGroup,
): z.infer<typeof categorySchema> {
  return {
    id: category.id,
    name: category.name,
    category_group_id: category.category_group_id,
    group_name: group?.name ?? category.category_group_name,
    group_hidden: group?.hidden,
    hidden: category.hidden,
    internal: category.internal,
    note: category.note,
    budgeted: category.budgeted,
    budgeted_formatted: category.budgeted_formatted,
    activity: category.activity,
    activity_formatted: category.activity_formatted,
    balance: category.balance,
    balance_formatted: category.balance_formatted,
    goal_type: category.goal_type,
    goal_target: category.goal_target,
    goal_target_formatted: category.goal_target_formatted,
    goal_target_date: category.goal_target_date,
    goal_percentage_complete: category.goal_percentage_complete,
    goal_under_funded: category.goal_under_funded,
    goal_under_funded_formatted: category.goal_under_funded_formatted,
  };
}
