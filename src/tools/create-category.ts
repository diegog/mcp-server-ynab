import { moneyArgument, toMilliunits } from "../money.ts";
import { idArgument, planIdArgument } from "./arguments.ts";
import { categorySchema, toCategory } from "./list-categories.ts";
import { defineTool } from "./registry.ts";
import { planIdResult } from "./shapes.ts";
import {
  categoryNameArgument,
  categoryNoteArgument,
  goalNeedsWholeAmountArgument,
  goalTargetDateArgument,
} from "./write-arguments.ts";

/** Add a category to a plan, filed into a group that already exists. */
export const createCategory = defineTool({
  name: "create_category",
  title: "Create a category",
  description:
    "Add a category to a plan, filed into an existing group. Setting `goal_target` gives the " +
    "category a monthly target of that amount; adding `goal_target_date` makes it a target by " +
    "that date instead. YNAB chooses the kind of target itself — there is no way to name one. " +
    "A category cannot be hidden or deleted through the API once it exists, only renamed and " +
    "re-filed, so creating one the user did not ask for leaves clutter only they can clear in " +
    "the YNAB app.",
  inputSchema: {
    plan_id: planIdArgument(),
    name: categoryNameArgument('Name for the new category, as it will read in YNAB, e.g. "Vet".'),
    category_group_id: idArgument(
      "The group to file the category under. It must already exist, and it cannot be one of " +
        "YNAB's own internal groups.",
      "list_categories",
    ),
    note: categoryNoteArgument("Free-text note on the category."),
    goal_target: moneyArgument("Target amount for the category.").optional(),
    goal_target_date: goalTargetDateArgument(),
    goal_needs_whole_amount: goalNeedsWholeAmountArgument(),
  },
  outputSchema: {
    plan_id: planIdResult(),
    category: categorySchema.describe(
      "The category as YNAB created it, with the target it worked out from the goal arguments. " +
        "`group_name` and `group_hidden` are absent: a create response carries no group.",
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const { data } = await client.api.categories.createCategory(planId, {
      // Only the keys the caller named: `exactOptionalPropertyTypes` aside, a body
      // that lists every field is a body that says something about every field.
      category: {
        name: args.name,
        category_group_id: args.category_group_id,
        ...(args.note !== undefined && { note: args.note }),
        ...(args.goal_target !== undefined && {
          goal_target: toMilliunits(args.goal_target, "goal_target"),
        }),
        ...(args.goal_target_date !== undefined && { goal_target_date: args.goal_target_date }),
        ...(args.goal_needs_whole_amount !== undefined && {
          goal_needs_whole_amount: args.goal_needs_whole_amount,
        }),
      },
    });
    return { plan_id: planId, category: toCategory(data.category) };
  },
});
