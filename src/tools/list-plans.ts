import { z } from "zod";
import { LAST_USED_PLAN_ID } from "../client.ts";
import { defineTool } from "./registry.ts";

/** What YNAB reports about a plan itself, apart from its formats and its contents. */
export const planFields = {
  id: z.string().describe("Plan id. Pass it as `plan_id` to any other tool."),
  name: z.string().describe("Name the user gave this plan in YNAB."),
  last_modified_on: z
    .string()
    .optional()
    .describe("When the plan last changed in a YNAB app, as an ISO 8601 timestamp."),
  first_month: z
    .string()
    .optional()
    .describe("Earliest month the plan covers, as the first day of that month: 2016-12-01."),
  last_month: z
    .string()
    .optional()
    .describe("Latest month the plan covers, as the first day of that month: 2016-12-01."),
};

type PlanFields = z.infer<z.ZodObject<typeof planFields>>;

/** Narrow a plan YNAB returned to {@link planFields}, dropping everything else it carries. */
export function toPlanFields(plan: PlanFields): PlanFields {
  return {
    id: plan.id,
    name: plan.name,
    last_modified_on: plan.last_modified_on,
    first_month: plan.first_month,
    last_month: plan.last_month,
  };
}

/**
 * Every plan the token can reach — the entry point to every other tool.
 * @see https://api.ynab.com/#endpoints
 */
export const listPlans = defineTool({
  name: "list_plans",
  title: "List plans",
  description:
    "List every plan (also called a budget) the access token can reach. Start here: nearly " +
    "every other tool takes a plan id, and this is where one comes from. Only the plans " +
    "themselves come back — a plan's accounts, categories and transactions each have their " +
    "own tool, and `get_plan` reports how a plan's amounts and dates are formatted.",
  inputSchema: {},
  outputSchema: {
    plans: z.array(z.object(planFields)).describe("Every plan the access token can reach."),
    configured_plan_id: z
      .string()
      .describe(
        "Id of the plan every tool acts on when `plan_id` is omitted. Absent when the server " +
          "has no plan configured, in which case YNAB uses whichever plan the user opened " +
          "most recently — name the plan explicitly when it matters which one is meant.",
      )
      .optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(_args, { client }) {
    const { data } = await client.api.plans.getPlans();
    const configured = client.resolvePlanId();
    return {
      plans: data.plans.map(toPlanFields),
      // `last-used` is YNAB's own placeholder, not an id, so there is nothing to report.
      configured_plan_id: configured === LAST_USED_PLAN_ID ? undefined : configured,
    };
  },
});
