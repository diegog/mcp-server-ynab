import type {
  MoneyMovement as YnabMoneyMovement,
  MoneyMovementGroup as YnabMoneyMovementGroup,
} from "ynab";
import { z } from "zod";
import type { YnabClient } from "../client.ts";
import { monthArgument, planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";

/** Said on every raw amount, since milliunits are not inferable from the name. */
const MILLIUNITS = "In milliunits, where 1000 is one unit of the plan's currency.";

/** Said on both resolved names, so an absent one is not read as an error. */
const UNRESOLVED =
  "Absent when the move has no category on that side — money coming from or going back to " +
  "Ready to Assign — and when the category is no longer in the plan.";

/** One move of money out of one category and into another. */
const moneyMovement = z.object({
  id: z.string().describe("Id of the money movement."),
  month: z
    .string()
    .optional()
    .describe("The plan month the money was moved within, as the first day of it: 2024-01-01."),
  moved_at: z.string().optional().describe("When the move was recorded, as an ISO 8601 timestamp."),
  note: z.string().optional().describe("Note left with the move, absent when there is none."),
  money_movement_group_id: z
    .string()
    .optional()
    .describe(
      "Id of the group this move belongs to. Moves sharing one were made in a single action.",
    ),
  performed_by_user_id: z.string().optional().describe("Id of the user who moved the money."),
  from_category_id: z.string().optional().describe("Id of the category the money was taken from."),
  from_category_name: z.string().optional().describe(`Name of that category. ${UNRESOLVED}`),
  to_category_id: z.string().optional().describe("Id of the category the money was moved into."),
  to_category_name: z.string().optional().describe(`Name of that category. ${UNRESOLVED}`),
  amount: z.number().describe(`The amount moved. ${MILLIUNITS}`),
  amount_formatted: z.string().optional().describe("`amount` written in the plan's currency."),
});

/** One action in which several moves were made at once. */
const moneyMovementGroup = z.object({
  id: z.string().describe("Id of the group, carried by every move made in the same action."),
  group_created_at: z.string().describe("When the action was taken, as an ISO 8601 timestamp."),
  month: z
    .string()
    .describe("The plan month the money was moved within, as the first day of it: 2024-01-01."),
  note: z.string().nullish().describe("Note left with the action, absent when there is none."),
  performed_by_user_id: z.string().nullish().describe("Id of the user who moved the money."),
});

/** A money movement as this server reports it. */
type MoneyMovement = z.infer<typeof moneyMovement>;

/** A bundling action as this server reports it. */
type MoneyMovementGroup = z.infer<typeof moneyMovementGroup>;

/** Trace money moved between categories, or the actions that moved several at once. */
export const listMoneyMovements = defineTool({
  name: "list_money_movements",
  title: "List money movements",
  description:
    "Trace money moved between categories: the audit trail behind covering an overspent " +
    "category, and the only record of where that money was taken from. Each move names both " +
    "categories, so nothing further has to be looked up. Omit `month` to cover the whole plan. " +
    "Set `group_by_movement_group` to list the actions that bundled several moves together " +
    "instead of the moves themselves.",
  inputSchema: {
    plan_id: planIdArgument(),
    month: monthArgument("Only list money moved within this month. Omit it to cover every month."),
    group_by_movement_group: z
      .boolean()
      .optional()
      .describe(
        "List the actions money was moved in rather than the individual moves. Omit it, or " +
          "pass false, for the moves themselves — a group records who moved money and when, " +
          "but names no categories and no amounts, so ask for the moves to see where money went.",
      ),
  },
  outputSchema: {
    money_movements: z
      .array(moneyMovement)
      .optional()
      .describe("The individual moves. Absent when `group_by_movement_group` was set."),
    money_movement_groups: z
      .array(moneyMovementGroup)
      .optional()
      .describe("The bundling actions. Present only when `group_by_movement_group` was set."),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    // See AGENTS.md, "Scheduled transactions and money movements".
    const month = args.month?.trim() || undefined;

    if (args.group_by_movement_group === true) {
      const { data } = await (month === undefined
        ? client.api.money_movements.getMoneyMovementGroups(planId)
        : client.api.money_movements.getMoneyMovementGroupsByMonth(planId, month));
      return { money_movement_groups: data.money_movement_groups.map(toMoneyMovementGroup) };
    }

    const [movements, names] = await Promise.all([
      month === undefined
        ? client.api.money_movements.getMoneyMovements(planId)
        : client.api.money_movements.getMoneyMovementsByMonth(planId, month),
      categoryNames(client, planId),
    ]);

    return {
      money_movements: movements.data.money_movements.map((movement) =>
        toMoneyMovement(movement, names),
      ),
    };
  },
});

/**
 * One move of YNAB's, its categories named, field by field rather than spread —
 * see AGENTS.md, "Scheduled transactions and money movements".
 */
function toMoneyMovement(
  movement: YnabMoneyMovement,
  names: ReadonlyMap<string, string>,
): MoneyMovement {
  return {
    id: movement.id,
    month: movement.month,
    moved_at: movement.moved_at,
    note: movement.note,
    money_movement_group_id: movement.money_movement_group_id,
    performed_by_user_id: movement.performed_by_user_id,
    from_category_id: movement.from_category_id,
    from_category_name: nameOf(movement.from_category_id, names),
    to_category_id: movement.to_category_id,
    to_category_name: nameOf(movement.to_category_id, names),
    amount: movement.amount,
    amount_formatted: movement.amount_formatted,
  };
}

/** One bundling action of YNAB's, listed the same way for the same reason. */
function toMoneyMovementGroup(group: YnabMoneyMovementGroup): MoneyMovementGroup {
  return {
    id: group.id,
    group_created_at: group.group_created_at,
    month: group.month,
    note: group.note,
    performed_by_user_id: group.performed_by_user_id,
  };
}

/**
 * Every category in the plan, by id, in one request. The second request this
 * costs is deliberate — see AGENTS.md, "Scheduled transactions and money movements".
 */
async function categoryNames(
  client: YnabClient,
  planId: string,
): Promise<ReadonlyMap<string, string>> {
  const { data } = await client.api.categories.getCategories(planId);
  const names = new Map<string, string>();
  for (const group of data.category_groups) {
    for (const category of group.categories) {
      names.set(category.id, category.name);
    }
  }
  return names;
}

/** The category's name, or nothing when it has no id or no longer resolves to one. */
function nameOf(
  categoryId: string | undefined,
  names: ReadonlyMap<string, string>,
): string | undefined {
  return categoryId === undefined ? undefined : names.get(categoryId);
}
