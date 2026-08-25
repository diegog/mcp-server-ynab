/**
 * The record shapes more than one tool file returns, and the mappers that build
 * them. See AGENTS.md, "The write surface".
 */
import type {
  HybridTransaction,
  ScheduledSubTransaction,
  ScheduledTransactionDetail,
  TransactionDetail,
} from "ynab";
import { z } from "zod";

/** A row of any transaction query: YNAB returns two shapes and this is either. */
export type YnabTransaction = TransactionDetail | HybridTransaction;

/** Said on every raw amount, since milliunits are not inferable from the name. */
const MILLIUNITS =
  "In milliunits, where 1000 is one unit of the plan's currency, and outflows are negative.";

/**
 * YNAB's repeat intervals as reported, listed rather than enumerated — see
 * AGENTS.md, "Scheduled transactions and money movements". The write path takes
 * the same thirteen as a `z.enum`; see `frequencyArgument`.
 */
const FREQUENCIES =
  '"never", "daily", "weekly", "everyOtherWeek", "twiceAMonth", "every4Weeks", "monthly", ' +
  '"everyOtherMonth", "every3Months", "every4Months", "twiceAYear", "yearly", "everyOtherYear".';

/**
 * The plan a write acted on, echoed back on every write result. See AGENTS.md,
 * "The write surface", on why a write says this and a read does not.
 */
export function planIdResult(): z.ZodString {
  return z
    .string()
    .describe(
      "Id of the plan this acted on, as the server resolved it. Check it against the plan the " +
        "ids came from: with no `plan_id` and no configured default, the server acts on " +
        "whichever plan was most recently opened in YNAB, which need not be the one a list " +
        "tool was read from.",
    );
}

/** One line of a split transaction. */
const subtransactionSchema = z.object({
  id: z.string().describe("Id of this line."),
  amount: z
    .number()
    .describe("Amount in milliunits, where 1000 is one currency unit. Outflows are negative."),
  amount_formatted: z.string().optional().describe("`amount` in the plan's currency format."),
  memo: z.string().optional().describe("Free text on this line."),
  payee_id: z.string().optional().describe("Payee of this line, when it differs from the parent."),
  payee_name: z.string().nullable().optional().describe("Name of that payee."),
  category_id: z.string().optional().describe("Category this line is assigned to."),
  category_name: z.string().nullable().optional().describe("Name of that category."),
  transfer_account_id: z.string().optional().describe("If this line is a transfer, its account."),
  transfer_transaction_id: z
    .string()
    .optional()
    .describe("If this line is a transfer, the transaction on the other side."),
  deleted: z.boolean().optional().describe("Present and true only if this line was deleted."),
});

/** A transaction, in the one shape every transaction query and write here reports. */
export const transactionSchema = z.object({
  id: z.string().describe("Id of the transaction."),
  date: z.string().describe("Date the transaction falls on, as ISO `YYYY-MM-DD`."),
  amount: z
    .number()
    .describe(
      "Amount in milliunits, where 1000 is one currency unit. Outflows are negative and " +
        "inflows positive.",
    ),
  amount_formatted: z
    .string()
    .optional()
    .describe("`amount` in the plan's currency format, ready to show the user."),
  memo: z.string().optional().describe("Free text on the transaction."),
  cleared: z
    .string()
    .describe(
      "Whether the transaction has cleared the account: `cleared`, `uncleared` or `reconciled`.",
    ),
  approved: z
    .boolean()
    .describe("Whether the transaction is approved. Imported transactions start unapproved."),
  flag_color: z
    .string()
    .nullable()
    .optional()
    .describe("Flag on the transaction: `red`, `orange`, `yellow`, `green`, `blue` or `purple`."),
  flag_name: z.string().optional().describe("The plan's own name for that flag colour."),
  account_id: z.string().describe("Account the transaction is in."),
  account_name: z.string().describe("Name of that account."),
  payee_id: z.string().optional().describe("Payee of the transaction."),
  payee_name: z.string().nullable().optional().describe("Name of that payee."),
  category_id: z
    .string()
    .optional()
    .describe("Category of the transaction. Absent on a transfer, and on a split."),
  category_name: z
    .string()
    .nullable()
    .optional()
    .describe("Name of that category, or `Split` when the categories are on the lines below."),
  transfer_account_id: z.string().optional().describe("If a transfer, the account money moved to."),
  transfer_transaction_id: z
    .string()
    .optional()
    .describe("If a transfer, the transaction on the other side of it."),
  matched_transaction_id: z
    .string()
    .optional()
    .describe("The imported transaction this one was matched against, if any."),
  import_id: z
    .string()
    .optional()
    .describe(
      "Id the transaction was imported under, unique within its account. Absent when it was " +
        "entered by hand.",
    ),
  debt_transaction_type: z
    .string()
    .nullable()
    .optional()
    .describe(
      "On a debt or loan account, what the transaction does: `payment`, `refund`, `fee`, " +
        "`interest`, `escrow`, `balanceAdjustment`, `credit` or `charge`.",
    ),
  deleted: z.boolean().optional().describe("Present and true only if the transaction was deleted."),
  type: z
    .string()
    .optional()
    .describe(
      "`transaction` or `subtransaction`. Present only when filtering by category or payee, " +
        "which return the lines of a split as rows in their own right.",
    ),
  parent_transaction_id: z
    .string()
    .nullable()
    .optional()
    .describe("On a `subtransaction` row, the split transaction the line belongs to."),
  subtransactions: z
    .array(subtransactionSchema)
    .optional()
    .describe(
      "The lines of a split transaction, empty when it is not a split. Absent when filtering " +
        "by category or payee.",
    ),
});

/** A transaction as this server reports it. */
export type Transaction = z.infer<typeof transactionSchema>;

/** One line of a scheduled transaction that is split across categories. */
const scheduledSubtransactionSchema = z.object({
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
export const scheduledTransactionSchema = z.object({
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
    .array(scheduledSubtransactionSchema)
    .describe("The split lines, empty unless the transaction is split across categories."),
});

/** A scheduled transaction as this server reports it. */
export type ScheduledTransaction = z.infer<typeof scheduledTransactionSchema>;

/** One of its split lines as this server reports it. */
type ScheduledSubtransaction = z.infer<typeof scheduledSubtransactionSchema>;

/** One row of either response shape, as this server reports it. */
export function toTransaction(row: YnabTransaction): Transaction {
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    amount_formatted: row.amount_formatted,
    memo: row.memo,
    cleared: row.cleared,
    approved: row.approved,
    flag_color: row.flag_color,
    flag_name: row.flag_name,
    account_id: row.account_id,
    account_name: row.account_name,
    payee_id: row.payee_id,
    payee_name: row.payee_name,
    category_id: row.category_id,
    category_name: row.category_name,
    transfer_account_id: row.transfer_account_id,
    transfer_transaction_id: row.transfer_transaction_id,
    matched_transaction_id: row.matched_transaction_id,
    import_id: row.import_id,
    debt_transaction_type: row.debt_transaction_type,
    type: "type" in row ? row.type : undefined,
    parent_transaction_id: "parent_transaction_id" in row ? row.parent_transaction_id : undefined,
    subtransactions:
      "subtransactions" in row ? row.subtransactions.map(toSubtransaction) : undefined,
    ...(row.deleted ? { deleted: true } : {}),
  };
}

/** One line of a split, dropping the parent id it is already nested under. */
function toSubtransaction(line: TransactionDetail["subtransactions"][number]) {
  return {
    id: line.id,
    amount: line.amount,
    amount_formatted: line.amount_formatted,
    memo: line.memo,
    payee_id: line.payee_id,
    payee_name: line.payee_name,
    category_id: line.category_id,
    category_name: line.category_name,
    transfer_account_id: line.transfer_account_id,
    transfer_transaction_id: line.transfer_transaction_id,
    ...(line.deleted ? { deleted: true } : {}),
  };
}

/**
 * One row of YNAB's response, field by field rather than spread — see AGENTS.md,
 * "Scheduled transactions and money movements".
 */
export function toScheduledTransaction(row: ScheduledTransactionDetail): ScheduledTransaction {
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
