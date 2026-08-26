import { idArgument, planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";
import { planIdResult, scheduledTransactionSchema, toScheduledTransaction } from "./shapes.ts";

/** Cancel a standing instruction. Occurrences already entered are untouched. */
export const deleteScheduledTransaction = defineTool({
  name: "delete_scheduled_transaction",
  title: "Delete a scheduled transaction",
  description:
    "Cancel a scheduled transaction so YNAB stops entering it. Occurrences already entered are " +
    "ordinary transactions and are left alone — deleting the schedule does not undo them, and " +
    "`delete_transaction` is what removes one of those. YNAB returns the cancelled schedule in " +
    "full, which is the only record of it left. There is no undelete.",
  inputSchema: {
    plan_id: planIdArgument(),
    scheduled_transaction_id: idArgument(
      "The scheduled transaction to cancel.",
      "list_scheduled_transactions",
    ),
  },
  outputSchema: {
    plan_id: planIdResult(),
    scheduled_transaction: scheduledTransactionSchema.describe(
      "The scheduled transaction as it was at the moment it was cancelled.",
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    // About the environment, not the response. See AGENTS.md, "The tool registry".
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const { data } = await client.api.scheduledTransactions.deleteScheduledTransaction(
      planId,
      args.scheduled_transaction_id,
    );
    return {
      plan_id: planId,
      scheduled_transaction: toScheduledTransaction(data.scheduled_transaction),
    };
  },
});
