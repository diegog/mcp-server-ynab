import { createAccount } from "./create-account.ts";
import { createCategory } from "./create-category.ts";
import { createCategoryGroup } from "./create-category-group.ts";
import { createPayee } from "./create-payee.ts";
import { createScheduledTransaction } from "./create-scheduled-transaction.ts";
import { createTransaction } from "./create-transaction.ts";
import { deleteScheduledTransaction } from "./delete-scheduled-transaction.ts";
import { deleteTransaction } from "./delete-transaction.ts";
import { getPlan } from "./get-plan.ts";
import { getTransaction } from "./get-transaction.ts";
import { getUser } from "./get-user.ts";
import { importTransactions } from "./import-transactions.ts";
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
import { updateCategory } from "./update-category.ts";
import { updateCategoryGroup } from "./update-category-group.ts";
import { updatePayee } from "./update-payee.ts";
import { updateScheduledTransaction } from "./update-scheduled-transaction.ts";

/** Every tool the server can serve. Order here is irrelevant — the registry sorts. */
export const TOOLS: readonly AnyToolDefinition[] = [
  createAccount,
  createCategory,
  createCategoryGroup,
  createPayee,
  createScheduledTransaction,
  createTransaction,
  deleteScheduledTransaction,
  deleteTransaction,
  getPlan,
  getTransaction,
  getUser,
  importTransactions,
  listAccounts,
  listCategories,
  listMoneyMovements,
  listMonths,
  listPayees,
  listPlans,
  listScheduledTransactions,
  listTransactions,
  setCategoryBudget,
  updateCategory,
  updateCategoryGroup,
  updatePayee,
  updateScheduledTransaction,
];
