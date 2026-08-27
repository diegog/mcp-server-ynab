import { toMilliunits } from "../money.ts";
import { planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";
import {
  scheduledTransactionBody,
  scheduledTransactionFields,
} from "./scheduled-transaction-arguments.ts";
import { planIdResult, scheduledTransactionSchema, toScheduledTransaction } from "./shapes.ts";

/** Set up a standing instruction YNAB will enter on a future date. */
export const createScheduledTransaction = defineTool({
  name: "create_scheduled_transaction",
  title: "Schedule a transaction",
  description:
    "Set up a transaction YNAB will enter on a future date, optionally repeating. This records " +
    "an intention rather than money that has moved: nothing appears in the account until the " +
    "date arrives. Use `create_transaction` for something that already happened. YNAB " +
    "documents no default for `frequency` and no meaning for individual values like " +
    "`twiceAMonth`, so set it from what the user actually said.",
  inputSchema: {
    plan_id: planIdArgument(),
    ...scheduledTransactionFields,
  },
  outputSchema: {
    plan_id: planIdResult(),
    scheduled_transaction: scheduledTransactionSchema.describe(
      "The scheduled transaction as YNAB created it, including the `date_next` it worked out.",
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
    const amount = toMilliunits(args.amount, "amount");
    const { data } = await client.api.scheduledTransactions.createScheduledTransaction(planId, {
      scheduled_transaction: scheduledTransactionBody(args, amount),
    });
    return {
      plan_id: planId,
      scheduled_transaction: toScheduledTransaction(data.scheduled_transaction),
    };
  },
});
