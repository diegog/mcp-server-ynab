import { z } from "zod";
import { ToolError } from "../errors.ts";
import { toMilliunits, transactionAmountArgument } from "../money.ts";
import { idArgument, planIdArgument } from "./arguments.ts";
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

/** Rows per call, for the reason `create_transaction` caps at the same number. */
const MAX_ROWS = 100;

/** One transaction to replace, addressed by `id` or by `import_id`. */
const existingTransaction = z.object({
  id: idArgument(
    "The transaction to change. Give this or `import_id`, not both.",
    "list_transactions",
  ).optional(),
  import_id: importIdArgument(),
  account_id: accountIdArgument("Account the transaction should be in."),
  date: transactionDateArgument(
    "Date the transaction should fall on. It cannot be in the future — YNAB treats a " +
      "future-dated transaction as a scheduled one, and the prohibition sits on the field, so " +
      "it binds updates as well as creates.",
  ),
  amount: transactionAmountArgument("Total amount the transaction should have."),
  payee_id: payeeIdArgument("Payee the transaction should have.").optional(),
  payee_name: transactionPayeeNameArgument(),
  category_id: categoryIdArgument(
    "Category the transaction should be assigned to. YNAB ignores a Credit Card Payment " +
      "category here without saying so, and cannot change the category of a split at all.",
  ).optional(),
  memo: memoArgument("Note the transaction should carry."),
  cleared: clearedArgument(),
  approved: approvedArgument(),
  flag_color: flagColorArgument(),
  subtransactions: z
    .array(z.unknown())
    .describe(
      "Not supported, and present only to say so. YNAB returns an error for `subtransactions` " +
        "on a transaction that is already a split, and offers no endpoint that adds, edits or " +
        "removes a line. Delete the transaction and create it again to change how it splits.",
    )
    .optional(),
});

/** Replace one transaction or many, addressed by id or by import id. */
export const updateTransaction = defineTool({
  name: "update_transaction",
  title: "Update transactions",
  description:
    "Change one or more existing transactions. **Send each transaction as it should read " +
    "afterwards, not just the parts that change**: read it with `get_transaction` or " +
    "`list_transactions` first and carry over every value the user wants kept. YNAB does not " +
    "document whether a field left out is preserved or cleared, so anything omitted may be " +
    "lost — `account_id`, `date` and `amount` are required here for that reason. A " +
    "transaction can be addressed by its `id`, or by the `import_id` it was imported under, " +
    "which is the only way to reach one whose id you never saw. Splits cannot be edited.",
  inputSchema: {
    plan_id: planIdArgument(),
    transactions: z
      .array(existingTransaction)
      .min(1, "Pass at least one transaction to update.")
      .max(MAX_ROWS, `At most ${MAX_ROWS} transactions per call; split a larger batch.`)
      .describe("The transactions to change. Pass one element to change a single transaction."),
  },
  outputSchema: {
    plan_id: planIdResult(),
    transaction_ids: z.array(z.string()).describe("Ids of the transactions that were changed."),
    transactions: z
      .array(transactionSchema)
      .optional()
      .describe(
        "The transactions in full as they now stand, when YNAB returned them. Compare them " +
          "with what you sent: anything meant to be kept and not resent shows up here as gone.",
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
    const today = new Date().toISOString().slice(0, 10);

    const transactions = args.transactions.map((row, index) => {
      const at = `transactions[${index}]`;
      if ((row.id === undefined) === (row.import_id === undefined)) {
        throw new ToolError(
          `\`${at}\` must name the transaction by exactly one of \`id\` or \`import_id\`, and ` +
            `it gave ${row.id === undefined ? "neither" : "both"}.`,
        );
      }
      if (row.subtransactions !== undefined) {
        throw new ToolError(
          `\`${at}.subtransactions\` was given. YNAB returns an error for subtransactions on a ` +
            "transaction that is already a split, and has no endpoint that adds, edits or " +
            "removes a line — a split's categories and amounts are fixed once it exists. " +
            "Delete it with `delete_transaction` and create it again to change how it splits.",
        );
      }
      if (row.date > today) {
        throw new ToolError(
          `\`${at}.date\` is ${row.date}, which is in the future. YNAB does not permit a ` +
            "future date on a transaction; that is what a scheduled transaction is for.",
        );
      }
      return {
        ...(row.id !== undefined && { id: row.id }),
        ...(row.import_id !== undefined && { import_id: row.import_id }),
        account_id: row.account_id,
        date: row.date,
        amount: toMilliunits(row.amount, `${at}.amount`),
        ...(row.payee_id !== undefined && { payee_id: row.payee_id }),
        ...(row.payee_name !== undefined && { payee_name: row.payee_name }),
        ...(row.category_id !== undefined && { category_id: row.category_id }),
        ...(row.memo !== undefined && { memo: row.memo }),
        ...(row.cleared !== undefined && { cleared: row.cleared }),
        ...(row.approved !== undefined && { approved: row.approved }),
        ...(row.flag_color !== undefined && { flag_color: row.flag_color }),
      };
    });

    const { data } = await client.api.transactions.updateTransactions(planId, { transactions });
    return {
      plan_id: planId,
      transaction_ids: data.transaction_ids,
      ...(data.transactions !== undefined && {
        transactions: data.transactions.map(toTransaction),
      }),
    };
  },
});
