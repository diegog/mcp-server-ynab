import { idArgument, planIdArgument } from "./arguments.ts";
import { toTransaction, transactionSchema } from "./list-transactions.ts";
import { defineTool } from "./registry.ts";

/** Fetch one transaction by id, in the shape `list_transactions` reports. */
export const getTransaction = defineTool({
  name: "get_transaction",
  title: "Get transaction",
  description:
    "Fetch a single transaction by id, with the lines of a split transaction included. There " +
    "is no search here: use `list_transactions` to find a transaction, and this tool only when " +
    "an id is already in hand and the whole record is wanted.",
  inputSchema: {
    plan_id: planIdArgument(),
    transaction_id: idArgument("The transaction to fetch.", "list_transactions"),
  },
  outputSchema: {
    transaction: transactionSchema.describe("The transaction."),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const { data } = await client.api.transactions.getTransactionById(planId, args.transaction_id);
    return { transaction: toTransaction(data.transaction) };
  },
});
