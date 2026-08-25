import { z } from "zod";
import { idArgument, planIdArgument } from "./arguments.ts";
import { defineTool } from "./registry.ts";

const payee = z.object({
  id: z.string().describe("The payee's id, which every tool that filters on a payee wants."),
  name: z.string().describe("The payee's name, as it reads in YNAB."),
  transfer_account_id: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Set when this payee is the far side of a transfer: the id of the account money moves " +
        "to. Null or absent on an ordinary payee.",
    ),
});

const payeeLocation = z.object({
  id: z.string().describe("The location's own id, which is what `payee_location_id` takes."),
  payee_id: z.string().describe("The payee this location belongs to."),
  latitude: z.string().describe("Latitude in decimal degrees. YNAB reports it as a string."),
  longitude: z.string().describe("Longitude in decimal degrees. YNAB reports it as a string."),
});

/** What a payee is reported as; the SDK's payee is a superset. */
type PlanPayee = z.infer<typeof payee>;

/** What a payee location is reported as; the SDK's location is a superset. */
type PlanPayeeLocation = z.infer<typeof payeeLocation>;

/** The payees of a plan, with their saved locations on request. */
export const listPayees = defineTool({
  name: "list_payees",
  title: "List payees",
  description:
    "List a plan's payees — the names transactions are recorded against — or one payee when " +
    "`payee_id` is given. Payee locations, the coordinates YNAB's phone app uses to guess a " +
    "payee from where you are standing, are left out unless `include_locations` asks for " +
    "them. Given `payee_location_id`, the tool answers with that one location alone: no " +
    "payees, and the other arguments ignored.",
  inputSchema: {
    plan_id: planIdArgument(),
    payee_id: idArgument(
      "Report on this payee alone. Omit it to list every payee in the plan.",
      "list_payees",
    ).optional(),
    include_locations: z
      .boolean()
      .default(false)
      .optional()
      .describe(
        "Also return the locations saved against these payees. Off by default: they are " +
          "coordinates for a phone app rather than anything a question about spending needs, " +
          "and fetching them costs a second request against YNAB's hourly limit.",
      ),
    payee_location_id: idArgument(
      "Read one saved location by its own id, which is not a payee id. Given this, the tool " +
        "returns that location and no payees, and ignores the other arguments. Location ids " +
        "come only from this tool called with `include_locations`.",
      "list_payees",
    ).optional(),
  },
  outputSchema: {
    payees: z
      .array(payee)
      .optional()
      .describe(
        "The plan's payees, or the one `payee_id` named. Absent when `payee_location_id` " +
          "asked for a single location instead.",
      ),
    payee_locations: z
      .array(payeeLocation)
      .optional()
      .describe(
        "Saved locations, present only when `include_locations` or `payee_location_id` asked " +
          "for them. Each names the payee it belongs to rather than sitting inside it.",
      ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { client }) {
    const planId = client.resolvePlanId(args.plan_id);
    // Blank counts as absent, as it does in `resolvePlanId`.
    const payeeId = args.payee_id?.trim() || undefined;
    const payeeLocationId = args.payee_location_id?.trim() || undefined;
    const { payeeLocations } = client.api;

    if (payeeLocationId !== undefined) {
      const { data } = await payeeLocations.getPayeeLocationById(planId, payeeLocationId);
      return { payee_locations: [toPayeeLocation(data.payee_location)] };
    }

    const found =
      payeeId === undefined
        ? (await client.api.payees.getPayees(planId)).data.payees
        : [(await client.api.payees.getPayeeById(planId, payeeId)).data.payee];
    if (!args.include_locations) return { payees: found.map(toPayee) };

    // One call for every payee's locations, never one call per payee: see
    // AGENTS.md, "Months and payees".
    const { data } =
      payeeId === undefined
        ? await payeeLocations.getPayeeLocations(planId)
        : await payeeLocations.getPayeeLocationsByPayee(planId, payeeId);

    return {
      payees: found.map(toPayee),
      payee_locations: data.payee_locations.map(toPayeeLocation),
    };
  },
});

/** Rebuilt field by field: what the API returns besides these is dropped on purpose. */
function toPayee(from: PlanPayee): PlanPayee {
  return { id: from.id, name: from.name, transfer_account_id: from.transfer_account_id };
}

/** Rebuilt field by field, as above. */
function toPayeeLocation(from: PlanPayeeLocation): PlanPayeeLocation {
  return {
    id: from.id,
    payee_id: from.payee_id,
    latitude: from.latitude,
    longitude: from.longitude,
  };
}
