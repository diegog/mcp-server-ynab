import { getPlan } from "./get-plan.ts";
import { getTransaction } from "./get-transaction.ts";
import { getUser } from "./get-user.ts";
import { listAccounts } from "./list-accounts.ts";
import { listCategories } from "./list-categories.ts";
import { listMonths } from "./list-months.ts";
import { listPayees } from "./list-payees.ts";
import { listPlans } from "./list-plans.ts";
import { listTransactions } from "./list-transactions.ts";
import type { AnyToolDefinition } from "./registry.ts";

/** Every tool the server serves. Order here is irrelevant — the registry sorts. */
export const TOOLS: readonly AnyToolDefinition[] = [
  getPlan,
  getTransaction,
  getUser,
  listAccounts,
  listCategories,
  listMonths,
  listPayees,
  listPlans,
  listTransactions,
];
