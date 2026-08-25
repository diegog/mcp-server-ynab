import { idArgument, planIdArgument } from "./arguments.ts";
import { payeeSchema, toPayee } from "./list-payees.ts";
import { defineTool } from "./registry.ts";
import { planIdResult } from "./shapes.ts";
import { payeeNameArgument } from "./write-arguments.ts";

/** Rename a payee, which is the only thing YNAB lets a payee's record change. */
export const updatePayee = defineTool({
  name: "update_payee",
  title: "Rename a payee",
  description:
    "Rename a payee. The name is the only thing about a payee YNAB will change, and there is " +
    "no way to delete one. Every transaction already recorded against the payee will read " +
    "under the new name. What happens when the new name is one another payee already has is " +
    "not documented — YNAB may merge the two or may not — so check `list_payees` for a clash " +
    "first and tell the user what you found rather than assuming either outcome.",
  inputSchema: {
    plan_id: planIdArgument(),
    payee_id: idArgument("The payee to rename.", "list_payees"),
    name: payeeNameArgument("The name the payee should have from now on."),
  },
  outputSchema: {
    plan_id: planIdResult(),
    payee: payeeSchema.describe("The payee as it stands after the rename."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const { data } = await client.api.payees.updatePayee(planId, args.payee_id, {
      payee: { name: args.name },
    });
    return { plan_id: planId, payee: toPayee(data.payee) };
  },
});
