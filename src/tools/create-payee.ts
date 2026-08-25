import { planIdArgument } from "./arguments.ts";
import { payeeSchema, toPayee } from "./list-payees.ts";
import { defineTool } from "./registry.ts";
import { planIdResult } from "./shapes.ts";
import { payeeNameArgument } from "./write-arguments.ts";

/** Add a payee to a plan without recording a transaction against it. */
export const createPayee = defineTool({
  name: "create_payee",
  title: "Create a payee",
  description:
    "Add a payee to a plan on its own. This is usually the wrong tool: `create_transaction` " +
    "takes a `payee_name` and will match an existing payee or create one as it records the " +
    "transaction, in a single request. Use this one only when the user wants the payee to " +
    "exist before there is anything to record against it. YNAB does not say what happens if " +
    "the name matches a payee that already exists, so check with `list_payees` first.",
  inputSchema: {
    plan_id: planIdArgument(),
    name: payeeNameArgument("Name for the new payee, as it will read in YNAB."),
  },
  outputSchema: {
    plan_id: planIdResult(),
    payee: payeeSchema.describe("The payee as YNAB created it."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const { data } = await client.api.payees.createPayee(planId, { payee: { name: args.name } });
    return { plan_id: planId, payee: toPayee(data.payee) };
  },
});
