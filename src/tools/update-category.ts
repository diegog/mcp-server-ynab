import { ToolError } from "../errors.ts";
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

/** Rename, re-file, or re-target a category. Not its budgeted amount. */
export const updateCategory = defineTool({
  name: "update_category",
  title: "Update a category",
  description:
    "Rename a category, move it to another group, or change its target. This is not how money " +
    "is assigned to a category — that is `set_category_budget`. Only the fields you pass are " +
    "changed; pass `goal_target: null` to remove a target entirely. A category cannot be " +
    "hidden, unhidden or deleted through the API, so renaming and re-filing is the whole " +
    "extent of the control there is over an existing one.",
  inputSchema: {
    plan_id: planIdArgument(),
    category_id: idArgument("The category to update.", "list_categories"),
    name: categoryNameArgument("A new name for the category.").optional(),
    category_group_id: idArgument(
      "Move the category into this group. It cannot be one of YNAB's own internal groups.",
      "list_categories",
    ).optional(),
    note: categoryNoteArgument("A new free-text note on the category."),
    goal_target: moneyArgument(
      "A new target amount for the category, which gives it a monthly target if it has none. " +
        "Pass `null` to remove the target it has.",
    )
      .nullable()
      .optional(),
    goal_target_date: goalTargetDateArgument(),
    goal_needs_whole_amount: goalNeedsWholeAmountArgument(),
  },
  outputSchema: {
    plan_id: planIdResult(),
    category: categorySchema.describe(
      "The category as it stands after the update. `group_name` and `group_hidden` are absent: " +
        "an update response carries no group.",
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const { plan_id, category_id, goal_target, ...fields } = args;
    // YNAB accepts `{"category": {}}` and does not say what it does with it, so
    // an update naming nothing is refused rather than sent.
    if (goal_target === undefined && Object.values(fields).every((v) => v === undefined)) {
      throw new ToolError(
        "no field to update was given. Pass at least one of `name`, `category_group_id`, " +
          "`note`, `goal_target`, `goal_target_date` or `goal_needs_whole_amount` — to change " +
          "what a category has budgeted for a month, use `set_category_budget` instead.",
      );
    }

    const planId = client.resolvePlanId(plan_id);
    const target = goal_target === null ? null : toMilliunits(goal_target, "goal_target");
    const { data } = await client.api.categories.updateCategory(planId, category_id, {
      // Only the keys the caller named. An omitted field and a cleared one have
      // to stay distinguishable on the wire — see AGENTS.md, "Category structure".
      category: {
        ...(fields.name !== undefined && { name: fields.name }),
        ...(fields.category_group_id !== undefined && {
          category_group_id: fields.category_group_id,
        }),
        ...(fields.note !== undefined && { note: fields.note }),
        // `goal_target: null` is YNAB's documented way to clear a target and the
        // SDK's serialiser forwards it, but its generator dropped `| null` from
        // this model, so the null is asserted past a type that never allowed it.
        ...(target !== undefined && { goal_target: target as number }),
        ...(fields.goal_target_date !== undefined && {
          goal_target_date: fields.goal_target_date,
        }),
        ...(fields.goal_needs_whole_amount !== undefined && {
          goal_needs_whole_amount: fields.goal_needs_whole_amount,
        }),
      },
    });
    return { plan_id: planId, category: toCategory(data.category) };
  },
});
