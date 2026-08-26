import { idArgument, planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";
import { planIdResult, toTransaction, transactionSchema } from "./shapes.ts";

/** Delete one transaction, which YNAB hands back in full as it goes. */
export const deleteTransaction = defineTool({
  name: "delete_transaction",
  title: "Delete a transaction",
  description:
    "Delete a transaction from a plan. YNAB returns the deleted transaction in full, which is " +
    "the only record of it left — read it back to the user. There is no undelete: recreating " +
    "it with `create_transaction` makes a new transaction with a new id, and any split lines " +
    "have to be given again. Deleting a transaction that is already gone answers with a " +
    "not-found rather than deleting anything twice.",
  inputSchema: {
    plan_id: planIdArgument(),
    transaction_id: idArgument("The transaction to delete.", "list_transactions"),
  },
  outputSchema: {
    plan_id: planIdResult(),
    transaction: transactionSchema.describe(
      "The transaction as it was at the moment it was deleted, split lines included.",
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    // About the environment, not the response: a second delete leaves the world
    // in the state the first left it in. See AGENTS.md, "The tool registry".
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const { data } = await client.api.transactions.deleteTransaction(planId, args.transaction_id);
    return { plan_id: planId, transaction: toTransaction(data.transaction) };
  },
});
