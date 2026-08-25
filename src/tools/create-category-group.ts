import { z } from "zod";
import { planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";
import { planIdResult } from "./shapes.ts";
import { categoryGroupNameArgument } from "./write-arguments.ts";

/**
 * One category group. Groups have no GET endpoints, so this is the only direct
 * view of one the API will return — see AGENTS.md, "Category structure".
 */
export const categoryGroupSchema = z.object({
  id: z.string().describe("Group id, opaque. Pass it as `category_group_id` to file a category."),
  name: z.string().describe('Group name as it appears in YNAB, e.g. "Immediate Obligations".'),
  hidden: z
    .boolean()
    .describe(
      "Whether the group is hidden in YNAB, which hides every category in it whatever the " +
        "category's own `hidden` says.",
    ),
  internal: z
    .boolean()
    .describe("True for YNAB's own built-in groups. A category cannot be filed into one."),
});

/** Add a category group to a plan. */
export const createCategoryGroup = defineTool({
  name: "create_category_group",
  title: "Create a category group",
  description:
    "Add a category group — the heading categories sit under in YNAB. The group comes back " +
    "empty; file categories into it with `create_category`, or move existing ones with " +
    "`update_category`. A group cannot be hidden or deleted through the API, so creating one " +
    "the user did not ask for leaves clutter only they can clear, in the app.",
  inputSchema: {
    plan_id: planIdArgument(),
    name: categoryGroupNameArgument("Name for the new group, as it will read in YNAB."),
  },
  outputSchema: {
    plan_id: planIdResult(),
    category_group: categoryGroupSchema.describe(
      "The group as YNAB created it. Keep the id: groups have no listing endpoint of their " +
        "own, and the only other way to find one is the `group_name` on a category in " +
        "`list_categories`.",
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
    const { data } = await client.api.categories.createCategoryGroup(planId, {
      category_group: { name: args.name },
    });
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
