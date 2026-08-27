/**
 * The field set `create_scheduled_transaction` and `update_scheduled_transaction`
 * share. Both endpoints take the identical `SaveScheduledTransaction`, so the
 * arguments are built once — see AGENTS.md, "Scheduling transactions".
 */
import { z } from "zod";
import { ToolError } from "../errors.ts";
import { transactionAmountArgument } from "../money.ts";
import {
  accountIdArgument,
  categoryIdArgument,
  flagColorArgument,
  frequencyArgument,
  memoArgument,
  payeeIdArgument,
  transactionDateArgument,
  transactionPayeeNameArgument,
} from "./write-arguments.ts";

/** YNAB's stated ceiling on how far ahead a scheduled transaction may sit. */
const MAX_YEARS_AHEAD = 5;

/** Everything `SaveScheduledTransaction` carries, which is nine fields. */
export const scheduledTransactionFields = {
  account_id: accountIdArgument("Account each occurrence will be entered in."),
  date: transactionDateArgument(
    "Date of the next occurrence. It must be in the future — a scheduled transaction is an " +
      `instruction for something that has not happened yet — and no more than ${MAX_YEARS_AHEAD} ` +
      "years ahead. To record something that already happened, use `create_transaction`.",
  ),
  amount: transactionAmountArgument("Amount each occurrence will be entered for.").optional(),
  payee_id: payeeIdArgument(
    "Payee each occurrence is recorded against. For a transfer, pass the other account's " +
      "`transfer_payee_id` from `list_accounts` and leave `category_id` off.",
  ).optional(),
  payee_name: transactionPayeeNameArgument(),
  category_id: categoryIdArgument(
    "Category each occurrence is assigned to. Leave it off for a transfer. A Credit Card " +
      "Payment category is not permitted here, and `list_categories` returns those unfiltered, " +
      "so check the group before picking one.",
  ).optional(),
  memo: memoArgument("Note carried onto each occurrence."),
  flag_color: flagColorArgument(),
  frequency: frequencyArgument(),
  // Declared so that a model reaching for a split is told why it cannot have
  // one. Zod strips unknown keys in silence, and a scheduled transaction
  // created quietly without its lines is the failure mode worth spending a
  // schema field on. See AGENTS.md, "Scheduling transactions".
  subtransactions: z
    .array(z.unknown())
    .describe(
      "Not supported, and present only to say so. YNAB has no way to express a scheduled " +
        "transaction split across categories — no schema field, no endpoint — so passing this " +
        "fails rather than quietly scheduling something with its lines dropped. Schedule one " +
        "transaction per category, or record a split with `create_transaction` when it happens.",
    )
    .optional(),
};

/** What a caller supplies for either write, once zod has parsed it. */
export type ScheduledTransactionArgs = z.infer<z.ZodObject<typeof scheduledTransactionFields>>;

/**
 * The body for either endpoint, with the rules YNAB words as advice and gives no
 * error for checked before a request is spent on them.
 */
export function scheduledTransactionBody(
  args: ScheduledTransactionArgs,
  amount: number | undefined,
) {
  if (args.subtransactions !== undefined) {
    throw new ToolError(
      "`subtransactions` was given, but YNAB cannot schedule a split transaction: there is no " +
        "field for it on the endpoint and no way to add lines afterwards. Schedule one " +
        "transaction per category instead, or record the split with `create_transaction` on " +
        "the day it happens.",
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  if (args.date <= today) {
    throw new ToolError(
      `\`date\` is ${args.date}, which is not in the future. A scheduled transaction is an ` +
        "instruction for something YNAB has yet to enter, so its date has to be later than " +
        `today (${today}). To record a transaction that already happened, use ` +
        "`create_transaction` instead.",
    );
  }
  if (args.date > horizon(today)) {
    throw new ToolError(
      `\`date\` is ${args.date}, which is more than ${MAX_YEARS_AHEAD} years ahead. YNAB does ` +
        `not schedule further out than ${horizon(today)}.`,
    );
  }

  return {
    account_id: args.account_id,
    date: args.date,
    ...(amount !== undefined && { amount }),
    ...(args.payee_id !== undefined && { payee_id: args.payee_id }),
    ...(args.payee_name !== undefined && { payee_name: args.payee_name }),
    ...(args.category_id !== undefined && { category_id: args.category_id }),
    ...(args.memo !== undefined && { memo: args.memo }),
    ...(args.flag_color !== undefined && { flag_color: args.flag_color }),
    ...(args.frequency !== undefined && { frequency: args.frequency }),
  };
}

/** The latest date YNAB will schedule, counted from `today` in UTC. */
function horizon(today: string): string {
  const [year = "", rest = ""] = [today.slice(0, 4), today.slice(4)];
  return `${Number(year) + MAX_YEARS_AHEAD}${rest}`;
}
