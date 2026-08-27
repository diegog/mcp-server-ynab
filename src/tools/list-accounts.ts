import { z } from "zod";
import type { YnabApi } from "../client.ts";
import { idArgument, planIdArgument, supplied } from "./arguments.ts";
import { defineTool } from "./registry.ts";

/** The SDK's account model, reached without importing `ynab`. See AGENTS.md. */
type YnabAccount = Awaited<ReturnType<YnabApi["accounts"]["getAccountById"]>>["data"]["account"];

/** One account of a plan. See AGENTS.md, "Accounts and categories". */
export const accountSchema = z.object({
  id: z.string().describe("Account id, opaque. Pass it to the tools that take an account."),
  name: z.string().describe('Account name as it appears in YNAB, e.g. "Chase Checking".'),
  type: z
    .string()
    .describe(
      "Kind of account: checking, savings, cash, creditCard, lineOfCredit, otherAsset, " +
        "otherLiability, mortgage, autoLoan, studentLoan, personalLoan, medicalDebt or " +
        "otherDebt. YNAB adds kinds without warning, so treat the list as open.",
    ),
  on_budget: z
    .boolean()
    .describe(
      "Whether the account's money is part of the plan and can be assigned to categories. " +
        "Tracking accounts (investments, a mortgage) are off budget.",
    ),
  closed: z.boolean().describe("Whether the account is closed. Closed accounts are still listed."),
  note: z.string().optional().describe("Free-text note on the account, when it has one."),
  balance: z
    .number()
    .describe(
      "Working balance in milliunits, where 1000 is one currency unit. Cleared plus uncleared.",
    ),
  balance_formatted: z
    .string()
    .optional()
    .describe('The working balance in the plan\'s currency format, e.g. "$1,234.56".'),
  cleared_balance: z.number().describe("Balance of cleared transactions only, in milliunits."),
  cleared_balance_formatted: z
    .string()
    .optional()
    .describe("The cleared balance in the plan's currency format."),
  uncleared_balance: z.number().describe("Balance of uncleared transactions only, in milliunits."),
  uncleared_balance_formatted: z
    .string()
    .optional()
    .describe("The uncleared balance in the plan's currency format."),
  transfer_payee_id: z
    .string()
    .nullable()
    .describe(
      "The payee that stands for this account in a transfer: use it as the payee when moving " +
        "money into this account. Null when YNAB reports none.",
    ),
  last_reconciled_at: z
    .string()
    .optional()
    .describe("When the account was last reconciled, ISO 8601. Absent if it never has been."),
  direct_import_linked: z
    .boolean()
    .optional()
    .describe("Whether YNAB imports this account's transactions from the bank automatically."),
  direct_import_in_error: z
    .boolean()
    .optional()
    .describe("Whether that bank connection has broken, in which case the balances may be stale."),
});

/**
 * The accounts of a plan, or one of them.
 * @see https://api.ynab.com/v1
 */
export const listAccounts = defineTool({
  name: "list_accounts",
  title: "List accounts",
  description:
    "List a plan's accounts with their balances, or just one when account_id is given. This is " +
    'how a name like "Chase Checking" becomes the `account_id` other tools take. Closed and ' +
    "off-budget accounts are included, each flagged as such.",
  inputSchema: {
    plan_id: planIdArgument(),
    account_id: idArgument(
      "Return only this account instead of all of them.",
      "list_accounts",
    ).optional(),
  },
  outputSchema: {
    accounts: z
      .array(accountSchema)
      .describe("The plan's accounts, in YNAB's own order, or the single one that was asked for."),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const accountId = supplied(args.account_id);
    if (accountId !== undefined) {
      const { data } = await client.api.accounts.getAccountById(planId, accountId);
      return { accounts: [toAccount(data.account)] };
    }
    const { data } = await client.api.accounts.getAccounts(planId);
    return { accounts: data.accounts.map(toAccount) };
  },
});

/** Rebuilt field by field; `create_account` reports the same shape. */
export function toAccount(account: YnabAccount): z.infer<typeof accountSchema> {
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    on_budget: account.on_budget,
    closed: account.closed,
    note: account.note,
    balance: account.balance,
    balance_formatted: account.balance_formatted,
    cleared_balance: account.cleared_balance,
    cleared_balance_formatted: account.cleared_balance_formatted,
    uncleared_balance: account.uncleared_balance,
    uncleared_balance_formatted: account.uncleared_balance_formatted,
    transfer_payee_id: account.transfer_payee_id,
    last_reconciled_at: account.last_reconciled_at,
    direct_import_linked: account.direct_import_linked,
    direct_import_in_error: account.direct_import_in_error,
  };
}
