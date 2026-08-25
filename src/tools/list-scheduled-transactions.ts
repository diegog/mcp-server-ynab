import type { ScheduledSubTransaction, ScheduledTransactionDetail } from "ynab";
import { z } from "zod";
import { idArgument, planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";

/** Said on every raw amount, since milliunits are not inferable from the name. */
const MILLIUNITS =
  "In milliunits, where 1000 is one unit of the plan's currency, and outflows are negative.";

/**
 * YNAB's repeat intervals, listed rather than enumerated — see AGENTS.md,
 * "Scheduled transactions and money movements".
 */
const FREQUENCIES =
  '"never", "daily", "weekly", "everyOtherWeek", "twiceAMonth", "every4Weeks", "monthly", ' +
  '"everyOtherMonth", "every3Months", "every4Months", "twiceAYear", "yearly", "everyOtherYear".';

/** One line of a scheduled transaction that is split across categories. */
const scheduledSubtransaction = z.object({
  id: z.string().describe("Id of this split line."),
  scheduled_transaction_id: z
    .string()
    .describe("Id of the scheduled transaction this line belongs to."),
  amount: z.number().describe(`The line's share of the total. ${MILLIUNITS}`),
  amount_formatted: z.string().optional().describe("`amount` written in the plan's currency."),
  memo: z.string().optional().describe("Note on this line, absent when it has none."),
  payee_id: z.string().optional().describe("Id of this line's payee, absent when it has none."),
  payee_name: z.string().optional().describe("Name of that payee."),
  category_id: z
    .string()
    .optional()
    .describe("Id of this line's category, absent when it is uncategorised."),
  category_name: z.string().optional().describe("Name of that category."),
  transfer_account_id: z
    .string()
    .optional()
    .describe("Account this line moves money to, when the line is a transfer rather than a spend."),
  deleted: z
    .boolean()
    .describe("True once the line has been deleted; YNAB keeps the record so clients can sync."),
});

/** A scheduled transaction, with its account, payee and category named inline. */
export const scheduledTransaction = z.object({
  id: z.string().describe("Id of the scheduled transaction."),
  date_first: z.string().describe("Date it was first scheduled for, as YYYY-MM-DD."),
  date_next: z.string().describe("Date the next occurrence is due to be entered, as YYYY-MM-DD."),
  frequency: z.string().describe(`How often it repeats. One of ${FREQUENCIES}`),
  amount: z.number().describe(`The amount each occurrence will be entered for. ${MILLIUNITS}`),
  amount_formatted: z.string().optional().describe("`amount` written in the plan's currency."),
  memo: z
    .string()
    .optional()
    .describe("Note on the scheduled transaction, absent when it has none."),
  flag_color: z
    .string()
    .nullish()
    .describe('Flag colour: "red", "orange", "yellow", "green", "blue", "purple", or "" for none.'),
  flag_name: z
    .string()
    .optional()
    .describe("The plan's own name for that flag colour, if it has one."),
  account_id: z.string().describe("Id of the account each occurrence will be entered in."),
  account_name: z.string().describe("Name of that account."),
  payee_id: z.string().optional().describe("Id of the payee, absent when there is none."),
  payee_name: z.string().nullish().describe("Name of that payee."),
  category_id: z
    .string()
    .optional()
    .describe("Id of the category, absent when the transaction is uncategorised or a transfer."),
  category_name: z
    .string()
    .nullish()
    .describe("Name of that category; a split transaction reports a placeholder name here."),
  transfer_account_id: z
    .string()
    .optional()
    .describe(
      "Account this moves money to, when the transaction is a transfer rather than a spend.",
    ),
  deleted: z
    .boolean()
    .describe("True once the transaction has been deleted; YNAB keeps the record so clients sync."),
  subtransactions: z
    .array(scheduledSubtransaction)
    .describe("The split lines, empty unless the transaction is split across categories."),
});

/** A scheduled transaction as this server reports it. */
type ScheduledTransaction = z.infer<typeof scheduledTransaction>;

/** One of its split lines as this server reports it. */
type ScheduledSubtransaction = z.infer<typeof scheduledSubtransaction>;

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
      .array(scheduledTransaction)
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

/**
 * One row of YNAB's response, field by field rather than spread — see AGENTS.md,
 * "Scheduled transactions and money movements".
 */
function toScheduledTransaction(row: ScheduledTransactionDetail): ScheduledTransaction {
  return {
    id: row.id,
    date_first: row.date_first,
    date_next: row.date_next,
    frequency: row.frequency,
    amount: row.amount,
    amount_formatted: row.amount_formatted,
    memo: row.memo,
    flag_color: row.flag_color,
    flag_name: row.flag_name,
    account_id: row.account_id,
    account_name: row.account_name,
    payee_id: row.payee_id,
    payee_name: row.payee_name,
    category_id: row.category_id,
    category_name: row.category_name,
    transfer_account_id: row.transfer_account_id,
    deleted: row.deleted,
    subtransactions: row.subtransactions.map(toScheduledSubtransaction),
  };
}

/** One split line of one, listed the same way for the same reason. */
function toScheduledSubtransaction(line: ScheduledSubTransaction): ScheduledSubtransaction {
  return {
    id: line.id,
    scheduled_transaction_id: line.scheduled_transaction_id,
    amount: line.amount,
    amount_formatted: line.amount_formatted,
    memo: line.memo,
    payee_id: line.payee_id,
    payee_name: line.payee_name,
    category_id: line.category_id,
    category_name: line.category_name,
    transfer_account_id: line.transfer_account_id,
    deleted: line.deleted,
  };
}
