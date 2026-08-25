import { createAccount } from "./create-account.ts";
import { createPayee } from "./create-payee.ts";
import { getPlan } from "./get-plan.ts";
import { getTransaction } from "./get-transaction.ts";
import { getUser } from "./get-user.ts";
import { listAccounts } from "./list-accounts.ts";
import { listCategories } from "./list-categories.ts";
import { listMoneyMovements } from "./list-money-movements.ts";
import { listMonths } from "./list-months.ts";
import { listPayees } from "./list-payees.ts";
import { listPlans } from "./list-plans.ts";
import { listScheduledTransactions } from "./list-scheduled-transactions.ts";
import { listTransactions } from "./list-transactions.ts";
import type { AnyToolDefinition } from "./registry.ts";
import { setCategoryBudget } from "./set-category-budget.ts";
import { updatePayee } from "./update-payee.ts";

/** Every tool the server can serve. Order here is irrelevant — the registry sorts. */
export const TOOLS: readonly AnyToolDefinition[] = [
  createAccount,
  createPayee,
  getPlan,
  getTransaction,
  getUser,
  listAccounts,
  listCategories,
  listMoneyMovements,
  listMonths,
  listPayees,
  listPlans,
  listScheduledTransactions,
  listTransactions,
  setCategoryBudget,
  updatePayee,
];
