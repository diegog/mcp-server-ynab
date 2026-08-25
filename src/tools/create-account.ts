import { z } from "zod";
import { moneyArgument, toMilliunits } from "../money.ts";
import { planIdArgument } from "./arguments.ts";
import { accountSchema, toAccount } from "./list-accounts.ts";
import { defineTool } from "./registry.ts";
import { planIdResult } from "./shapes.ts";
import { accountTypeArgument } from "./write-arguments.ts";

/** Add an account to a plan. The one write here with no undo. */
export const createAccount = defineTool({
  name: "create_account",
  title: "Create an account",
  description:
    "Add an account to a plan. **This cannot be undone through this server**: YNAB's API has " +
    "no endpoint that renames, closes or deletes an account, so a wrong name, a wrong type or " +
    "a wrong opening balance can only be fixed by the user in the YNAB app. Confirm all three " +
    "with the user before calling, and read the result back to them. Only six kinds of account " +
    "can be created here; loan and debt accounts have to be added in the app.",
  inputSchema: {
    plan_id: planIdArgument(),
    name: z
      .string()
      .describe('Name for the account as it will read in YNAB, e.g. "Chase Checking".'),
    type: accountTypeArgument(),
    balance: moneyArgument(
      "The balance the account starts with. Negative for money owed, which is how a credit " +
        "card or a liability is opened. YNAB records it as the account's starting balance.",
    ),
  },
  outputSchema: {
    plan_id: planIdResult(),
    account: accountSchema.describe(
      "The account as YNAB created it. Read it back to the user: this is the only chance to " +
        "catch a wrong name or type while it is still cheap to talk about.",
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
    const { data } = await client.api.accounts.createAccount(planId, {
      account: { name: args.name, type: args.type, balance: toMilliunits(args.balance, "balance") },
    });
    return { plan_id: planId, account: toAccount(data.account) };
  },
});
