import { getPlan } from "./get-plan.ts";
import { getUser } from "./get-user.ts";
import { listPlans } from "./list-plans.ts";
import type { AnyToolDefinition } from "./registry.ts";

/** Every tool the server serves. Order here is irrelevant — the registry sorts. */
export const TOOLS: readonly AnyToolDefinition[] = [getPlan, getUser, listPlans];
