import { z } from "zod";
import { planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";
import { planIdResult } from "./shapes.ts";

/** Pull whatever the plan's linked bank accounts have waiting. */
export const importTransactions = defineTool({
  name: "import_transactions",
  title: "Import linked-account transactions",
  description:
    "Ask YNAB to fetch new transactions from every bank account linked to the plan — the " +
    "equivalent of clicking Import on each account in the web app. It takes no arguments " +
    "beyond the plan and imports from all linked accounts at once; there is no way to import " +
    "one account alone. Importing nothing is a normal, successful outcome and means there was " +
    "nothing new — do not call it again in the hope of a different answer.",
  inputSchema: {
    plan_id: planIdArgument(),
  },
  outputSchema: {
    plan_id: planIdResult(),
    imported: z
      .number()
      .describe("How many transactions were imported. Zero is a success, not a failure."),
    transaction_ids: z
      .array(z.string())
      .describe("Ids of the imported transactions. Empty when there was nothing to import."),
    summary: z
      .string()
      .describe(
        "What happened, in a sentence to pass to the user. When nothing was imported this says " +
          "why it cannot be narrowed further.",
      ),
  },
  annotations: {
    readOnlyHint: false,
    // Imported rows are matched against user-entered ones, and the imported
    // amount wins. See AGENTS.md, "Recording transactions".
    destructiveHint: true,
    // A second call imports whatever the bank delivered in between.
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    const { data } = await client.api.transactions.importTransactions(planId);
    const ids = data.transaction_ids;
    return {
      plan_id: planId,
      imported: ids.length,
      transaction_ids: ids,
      summary:
        ids.length === 0
          ? "Nothing was imported. YNAB does not say why, and the three possible reasons look " +
            "identical here: there was nothing new, the plan has no linked accounts, or a bank " +
            "connection has broken. `list_accounts` reports `direct_import_linked` and " +
            "`direct_import_in_error`, which tells the last two apart."
          : `${ids.length} transaction${ids.length === 1 ? "" : "s"} imported. They arrive ` +
            "unapproved, so the user reviews them in YNAB's Approve queue; `list_transactions` " +
            'with `type: "unapproved"` lists them.',
    };
  },
});
