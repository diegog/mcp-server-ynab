import { z } from "zod";
import { ToolError } from "../errors.ts";
import { toMilliunits, transactionAmountArgument } from "../money.ts";
import { planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";
import { planIdResult, toTransaction, transactionSchema } from "./shapes.ts";
import {
  accountIdArgument,
  approvedArgument,
  categoryIdArgument,
  clearedArgument,
  flagColorArgument,
  importIdArgument,
  memoArgument,
  payeeIdArgument,
  transactionDateArgument,
  transactionPayeeNameArgument,
} from "./write-arguments.ts";

/**
 * Rows per call. YNAB declares no maximum and answers an oversized payload with a
 * 503 request timeout rather than a validation error, so the cap is ours.
 */
const MAX_ROWS = 100;

/** One line of a split. A line has no date, no id and no nesting of its own. */
const splitLine = z.object({
  amount: transactionAmountArgument("This line's share of the transaction."),
  payee_id: payeeIdArgument(
    "Payee for this line, when it differs from the transaction's.",
  ).optional(),
  payee_name: transactionPayeeNameArgument(),
  category_id: categoryIdArgument("Category this line is assigned to.").optional(),
  memo: memoArgument("Note on this line."),
});

/** One transaction to create. */
const newTransaction = z.object({
  account_id: accountIdArgument("Account the transaction is recorded in."),
  date: transactionDateArgument(
    "Date the transaction happened. It cannot be in the future: YNAB treats a future-dated " +
      "transaction as a scheduled one and refuses it on this endpoint.",
  ),
  amount: transactionAmountArgument("Total amount of the transaction."),
  payee_id: payeeIdArgument(
    "Payee the money went to or came from. To record a transfer, pass the other account's " +
      "`transfer_payee_id` from `list_accounts` here and leave `category_id` off.",
  ).optional(),
  payee_name: transactionPayeeNameArgument(),
  category_id: categoryIdArgument(
    "Category the transaction is assigned to. Leave it off for a transfer, and off when " +
      "`subtransactions` is given — a split takes its categories from its lines. YNAB ignores " +
      "a Credit Card Payment category here without saying so, and `list_categories` returns " +
      "those unfiltered, so check the group before picking one.",
  ).optional(),
  memo: memoArgument("Note on the transaction."),
  cleared: clearedArgument(),
  approved: approvedArgument(),
  flag_color: flagColorArgument(),
  import_id: importIdArgument(),
  subtransactions: z
    .array(splitLine)
    .min(2, "A split needs at least two lines; a transaction with one category is not a split.")
    .describe(
      "Lines of a split transaction, each with its own amount and category. Omit for an " +
        "ordinary transaction. A split cannot be edited afterwards — YNAB supports no way to " +
        "add, change or remove a line once it exists — so get the lines right the first time.",
    )
    .optional(),
});

/** Record one transaction or many, in a single request. */
export const createTransaction = defineTool({
  name: "create_transaction",
  title: "Create transactions",
  description:
    "Record one or more transactions in a plan. Always takes an array, so recording ten costs " +
    `one request rather than ten; send at most ${MAX_ROWS} at a time and split a larger batch ` +
    "across calls. A transaction may be a simple spend, a transfer between accounts, or a " +
    "split across several categories. Dates cannot be in the future. Setting `import_id` on a " +
    "row marks it as imported, which makes YNAB match and overwrite a transaction the user " +
    "entered by hand — leave it off for anything recorded on the user's behalf.",
  inputSchema: {
    plan_id: planIdArgument(),
    transactions: z
      .array(newTransaction)
      .min(1, "Pass at least one transaction to create.")
      .max(MAX_ROWS, `At most ${MAX_ROWS} transactions per call; split a larger batch.`)
      .describe("The transactions to create. Pass one element to record a single transaction."),
  },
  outputSchema: {
    plan_id: planIdResult(),
    transaction_ids: z
      .array(z.string())
      .describe("Ids of the transactions that were created, in the order they were sent."),
    transactions: z
      .array(transactionSchema)
      .optional()
      .describe(
        "The created transactions in full, when YNAB returned them. It is not obliged to, so " +
          "treat `transaction_ids` as the record of what was created.",
      ),
    duplicate_import_ids: z
      .array(z.string())
      .optional()
      .describe(
        "`import_id`s that were **not** created, because a transaction on the same account " +
          "already carried them. Those rows were skipped and the rest were still created — " +
          "this is a success reporting what was already recorded, not a failure to retry.",
      ),
  },
  annotations: {
    readOnlyHint: false,
    // An `import_id` makes YNAB match and overwrite a user-entered transaction,
    // so this can destroy a prior value. See AGENTS.md, "Recording transactions".
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const today = new Date().toISOString().slice(0, 10);

    const transactions = args.transactions.map((row, index) => {
      const at = `transactions[${index}]`;
      // Refused here rather than sent: YNAB documents the rule on both the
      // endpoint and the field, and a request spent learning it is one of 200.
      if (row.date > today) {
        throw new ToolError(
          `\`${at}.date\` is ${row.date}, which is in the future. YNAB records a future-dated ` +
            "transaction as a scheduled transaction and will not create one here. Use today's " +
            "date or earlier.",
        );
      }
      if (row.subtransactions !== undefined && row.category_id !== undefined) {
        throw new ToolError(
          `\`${at}\` gives both \`category_id\` and \`subtransactions\`. A split takes its ` +
            "categories from its lines, so leave `category_id` off.",
        );
      }
      return {
        account_id: row.account_id,
        date: row.date,
        amount: toMilliunits(row.amount, `${at}.amount`),
        ...(row.payee_id !== undefined && { payee_id: row.payee_id }),
        ...(row.payee_name !== undefined && { payee_name: row.payee_name }),
        ...(row.memo !== undefined && { memo: row.memo }),
        ...(row.cleared !== undefined && { cleared: row.cleared }),
        ...(row.approved !== undefined && { approved: row.approved }),
        ...(row.flag_color !== undefined && { flag_color: row.flag_color }),
        ...(row.import_id !== undefined && { import_id: row.import_id }),
        ...splitOrCategory(row, at),
      };
    });

    const { data } = await client.api.transactions.createTransaction(planId, { transactions });
    return {
      plan_id: planId,
      transaction_ids: data.transaction_ids,
      ...(data.transactions !== undefined && {
        transactions: data.transactions.map(toTransaction),
      }),
      ...(data.duplicate_import_ids !== undefined &&
        data.duplicate_import_ids.length > 0 && {
          duplicate_import_ids: data.duplicate_import_ids,
        }),
    };
  },
});

/**
 * A split's `category_id` is an explicit `null` — YNAB's documented shape, which
 * the SDK's generator dropped `| null` from. See AGENTS.md, "Recording transactions".
 */
function splitOrCategory(
  row: z.infer<typeof newTransaction>,
  at: string,
): { category_id?: string; subtransactions?: { amount: number }[] } {
  if (row.subtransactions === undefined) {
    return row.category_id === undefined ? {} : { category_id: row.category_id };
  }
  return {
    category_id: null as unknown as string,
    subtransactions: row.subtransactions.map((line, index) => ({
      amount: toMilliunits(line.amount, `${at}.subtransactions[${index}].amount`),
      ...(line.payee_id !== undefined && { payee_id: line.payee_id }),
      ...(line.payee_name !== undefined && { payee_name: line.payee_name }),
      ...(line.category_id !== undefined && { category_id: line.category_id }),
      ...(line.memo !== undefined && { memo: line.memo }),
    })),
  };
}
