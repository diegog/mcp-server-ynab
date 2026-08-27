import { toMilliunits } from "../money.ts";
import { idArgument, planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";
import {
  scheduledTransactionBody,
  scheduledTransactionFields,
} from "./scheduled-transaction-arguments.ts";
import { planIdResult, scheduledTransactionSchema, toScheduledTransaction } from "./shapes.ts";

/** Replace a scheduled transaction. The endpoint takes the whole record, not a patch. */
export const updateScheduledTransaction = defineTool({
  name: "update_scheduled_transaction",
  title: "Update a scheduled transaction",
  description:
    "Change a scheduled transaction. **This replaces the whole record rather than patching " +
    "it**: YNAB's update takes exactly the same fields as the create, `account_id` and `date` " +
    "included, so send the scheduled transaction as it should read afterwards and not just the " +
    "parts that change. Read the current values with `list_scheduled_transactions` first and " +
    "carry over everything the user wants kept — a field left out is not guaranteed to " +
    "survive, and YNAB does not document which way it goes.",
  inputSchema: {
    plan_id: planIdArgument(),
    scheduled_transaction_id: idArgument(
      "The scheduled transaction to replace.",
      "list_scheduled_transactions",
    ),
    ...scheduledTransactionFields,
  },
  outputSchema: {
    plan_id: planIdResult(),
    scheduled_transaction: scheduledTransactionSchema.describe(
      "The scheduled transaction as it stands afterwards. Compare it with what you sent: " +
        "anything you meant to keep and did not resend shows up here as missing.",
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const amount = toMilliunits(args.amount, "amount");
    const { data } = await client.api.scheduledTransactions.updateScheduledTransaction(
      planId,
      args.scheduled_transaction_id,
      { scheduled_transaction: scheduledTransactionBody(args, amount) },
    );
    return {
      plan_id: planId,
      scheduled_transaction: toScheduledTransaction(data.scheduled_transaction),
    };
  },
});
