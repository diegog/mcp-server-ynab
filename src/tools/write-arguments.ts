/**
 * Arguments the write surface takes, described once. See AGENTS.md, "The write
 * surface", on why the enums here are strict where the read surface's are not.
 */
import { z } from "zod";
import { dateShape, idArgument } from "./arguments.ts";

/**
 * Lengths YNAB enforces and the SDK's generated models drop: they are declared
 * in the OpenAPI spec (v1.86.0) and nowhere in `node_modules/ynab`. Sending a
 * longer value spends one of 200 requests to be told 400.
 */
export const MAX_MEMO = 500;
export const MAX_TRANSACTION_PAYEE_NAME = 200;
export const MAX_IMPORT_ID = 36;
export const MAX_PAYEE_NAME = 500;
export const MAX_CATEGORY_GROUP_NAME = 50;

/** The flag colours YNAB accepts, plus the empty string, one of the two ways to clear one. */
const flagColorSchema = z.enum(["red", "orange", "yellow", "green", "blue", "purple", ""]);

/** The three states a transaction can be saved in. Unchanged since at least 2022. */
const clearedSchema = z.enum(["cleared", "uncleared", "reconciled"]);

/** YNAB's thirteen repeat intervals. Unchanged since at least 2022. */
const frequencySchema = z.enum([
  "never",
  "daily",
  "weekly",
  "everyOtherWeek",
  "twiceAMonth",
  "every4Weeks",
  "monthly",
  "everyOtherMonth",
  "every3Months",
  "every4Months",
  "twiceAYear",
  "yearly",
  "everyOtherYear",
]);

/**
 * The account types YNAB will create, which are six of the thirteen it reports.
 * A growing allow-list — four in v1.80.0, two more in v1.82.0 a week later — so
 * re-check it on the next SDK bump (ENG-38).
 */
const accountTypeSchema = z.enum([
  "checking",
  "savings",
  "cash",
  "creditCard",
  "otherAsset",
  "otherLiability",
]);

/** The account a transaction or scheduled transaction is entered in. */
export function accountIdArgument(meaning: string): z.ZodString {
  return idArgument(meaning, "list_accounts");
}

/** The category a transaction or scheduled transaction is assigned to. */
export function categoryIdArgument(meaning: string): z.ZodString {
  return idArgument(meaning, "list_categories");
}

/** The payee a transaction or scheduled transaction is with. */
export function payeeIdArgument(meaning: string): z.ZodString {
  return idArgument(meaning, "list_payees");
}

/** The date a transaction falls on, or that a scheduled one is next due. */
export function transactionDateArgument(meaning: string): z.ZodString {
  return dateShape().describe(`${meaning} An ISO date, written as 2026-08-14.`);
}

/**
 * A payee named rather than identified. YNAB resolves it against a rename rule
 * (only alongside an `import_id`), then an existing payee of the same name, then
 * by creating one — so a tool taking this creates payees.
 */
export function transactionPayeeNameArgument(): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .max(
      MAX_TRANSACTION_PAYEE_NAME,
      `Payee names are capped at ${MAX_TRANSACTION_PAYEE_NAME} characters here.`,
    )
    .describe(
      "Name of the payee, for when there is no `payee_id` to hand. YNAB matches it against an " +
        "existing payee of the same name and creates one if there is none, so this can add a " +
        "payee to the plan as a side effect. Ignored when `payee_id` is given, and capped at " +
        `${MAX_TRANSACTION_PAYEE_NAME} characters.`,
    )
    .optional();
}

/** Free text on a transaction or scheduled transaction. */
export function memoArgument(meaning: string): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .max(MAX_MEMO, `Memos are capped at ${MAX_MEMO} characters.`)
    .describe(`${meaning} Free text, at most ${MAX_MEMO} characters.`)
    .optional();
}

/**
 * The flag colour, which is the one argument here where `null` and `""` are both
 * meaningful: either clears an existing flag.
 */
export function flagColorArgument(): z.ZodOptional<z.ZodNullable<typeof flagColorSchema>> {
  return flagColorSchema
    .nullable()
    .describe(
      "Colour of the flag on the transaction: `red`, `orange`, `yellow`, `green`, `blue` or " +
        "`purple`. Pass `null` or the empty string to clear a flag that is already there. Omit " +
        "it to leave any existing flag alone.",
    )
    .optional();
}

/** Whether the transaction has cleared the account. Transactions only. */
export function clearedArgument(): z.ZodOptional<typeof clearedSchema> {
  return clearedSchema
    .describe(
      "Whether the transaction has cleared the account: `uncleared` for one YNAB has not seen " +
        "on a statement, `cleared` for one it has, `reconciled` for one locked against a " +
        "reconciled balance. Reconciling is hard to undo in YNAB, so pass `reconciled` only " +
        "when the user asked for it.",
    )
    .optional();
}

/** Whether the transaction skips YNAB's approval queue. Transactions only. */
export function approvedArgument(): z.ZodOptional<z.ZodBoolean> {
  return z
    .boolean()
    .describe(
      "Whether the transaction is already approved. Omit it and YNAB leaves the transaction " +
        "unapproved, so it waits in the user's Approve queue for review; passing `true` skips " +
        "that review entirely.",
    )
    .optional();
}

/** How often a scheduled transaction repeats. Scheduled transactions only. */
export function frequencyArgument(): z.ZodOptional<typeof frequencySchema> {
  return frequencySchema
    .describe(
      "How often the scheduled transaction repeats. `never` enters it once on its date and " +
        "does not repeat. YNAB documents no default and no definition for the individual " +
        "values, so set it from what the user said rather than inferring one.",
    )
    .optional();
}

/** The dedupe key that also marks a transaction as imported. Transactions only. */
export function importIdArgument(): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .max(MAX_IMPORT_ID, `An import_id is at most ${MAX_IMPORT_ID} characters.`)
    .describe(
      "Your own id for this transaction, unique within its account, so that sending it twice " +
        "creates it once. Setting it also tells YNAB the transaction was imported: YNAB then " +
        "matches it against a transaction the user entered by hand on the same account for the " +
        "same amount within ten days, and the imported amount wins. Omit it unless you are " +
        "importing from a system that has its own ids — a transaction recorded on the user's " +
        `behalf should be left user-entered. At most ${MAX_IMPORT_ID} characters.`,
    )
    .optional();
}

/** The name of a payee record, as `create_payee` and `update_payee` take it. */
export function payeeNameArgument(meaning: string): z.ZodString {
  return z
    .string()
    .max(MAX_PAYEE_NAME, `Payee names are capped at ${MAX_PAYEE_NAME} characters.`)
    .describe(`${meaning} At most ${MAX_PAYEE_NAME} characters.`);
}

/** The name of a category group, which YNAB caps far shorter than a payee's. */
export function categoryGroupNameArgument(meaning: string): z.ZodString {
  return z
    .string()
    .max(
      MAX_CATEGORY_GROUP_NAME,
      `Category group names are capped at ${MAX_CATEGORY_GROUP_NAME} characters.`,
    )
    .describe(`${meaning} At most ${MAX_CATEGORY_GROUP_NAME} characters.`);
}

/** The kind of account to create, which is narrower than the kinds YNAB reports. */
export function accountTypeArgument(): typeof accountTypeSchema {
  return accountTypeSchema.describe(
    "What kind of account this is. Only these six can be created through the API: " +
      "`checking`, `savings`, `cash`, `creditCard`, `otherAsset`, `otherLiability`. The " +
      "loan and debt types `list_accounts` reports — `mortgage`, `autoLoan` and the rest — " +
      "cannot be created here and have to be added in the YNAB app.",
  );
}
