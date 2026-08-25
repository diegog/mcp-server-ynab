import { idArgument, planIdArgument } from "./arguments.ts";
import { categoryGroupSchema } from "./create-category-group.ts";
import { defineTool } from "./registry.ts";
import { planIdResult } from "./shapes.ts";
import { categoryGroupNameArgument } from "./write-arguments.ts";

/** Rename a category group, which is all `SaveCategoryGroup` can express. */
export const updateCategoryGroup = defineTool({
  name: "update_category_group",
  title: "Rename a category group",
  description:
    "Rename a category group. The name is the only thing about a group YNAB will change: a " +
    "group cannot be hidden, unhidden or deleted through the API, and its categories move by " +
    "`update_category` rather than from here. Group ids come from `list_categories`, whose " +
    "rows name the group each category sits in.",
  inputSchema: {
    plan_id: planIdArgument(),
    category_group_id: idArgument("The group to rename.", "list_categories"),
    name: categoryGroupNameArgument("The name the group should have from now on."),
  },
  outputSchema: {
    plan_id: planIdResult(),
    category_group: categoryGroupSchema.describe("The group as it stands after the rename."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const { data } = await client.api.categories.updateCategoryGroup(
      planId,
      args.category_group_id,
      { category_group: { name: args.name } },
    );
    const group = data.category_group;
    return {
      plan_id: planId,
      category_group: {
        id: group.id,
        name: group.name,
        hidden: group.hidden,
        internal: group.internal,
      },
    };
  },
});
