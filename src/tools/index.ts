import { getTransaction } from "./get-transaction.ts";
import { getUser } from "./get-user.ts";
import { listTransactions } from "./list-transactions.ts";
import type { AnyToolDefinition } from "./registry.ts";

/** Every tool the server serves. Order here is irrelevant — the registry sorts. */
export const TOOLS: readonly AnyToolDefinition[] = [getTransaction, getUser, listTransactions];
