import { z } from "zod";
import { idArgument, planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";
import { scheduledTransactionSchema, toScheduledTransaction } from "./shapes.ts";

/** List the transactions YNAB will enter on a future date, or one of them by id. */
export const listScheduledTransactions = defineTool({
  name: "list_scheduled_transactions",
  title: "List scheduled transactions",
  description:
    "List the plan's scheduled transactions: what YNAB will enter on a future date, how often " +
    "it repeats, into which account, and for how much. These are standing instructions rather " +
    "than money that has already moved, so use them to answer what is coming up or what a " +
    "regular bill costs. Pass `scheduled_transaction_id` to return just one of them.",
  inputSchema: {
    plan_id: planIdArgument(),
    scheduled_transaction_id: idArgument(
      "Return only this scheduled transaction. Omit it to list every one in the plan.",
      "list_scheduled_transactions",
    ).optional(),
  },
  outputSchema: {
    scheduled_transactions: z
      .array(scheduledTransactionSchema)
      .describe(
        "The plan's scheduled transactions, or just the one asked for by id. Deleted ones are " +
          "left out: YNAB returns those only to a client asking for changes since its last " +
          "sync, which this server does not do yet.",
      ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);

    if (args.scheduled_transaction_id !== undefined) {
      const { data } = await client.api.scheduledTransactions.getScheduledTransactionById(
        planId,
        args.scheduled_transaction_id,
      );
      return { scheduled_transactions: [toScheduledTransaction(data.scheduled_transaction)] };
    }

    const { data } = await client.api.scheduledTransactions.getScheduledTransactions(planId);
    return { scheduled_transactions: data.scheduled_transactions.map(toScheduledTransaction) };
  },
});
