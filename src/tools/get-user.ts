import { z } from "zod";
import { defineTool } from "./registry.ts";

/**
 * Identify the account the access token belongs to.
 * @see https://api.ynab.com/#personal-access-tokens
 */
export const getUser = defineTool({
  name: "get_user",
  title: "Get user",
  description:
    "Identify the YNAB user the server is authenticated as. Returns only a user id — " +
    "no other tool needs it, so this is mainly a way to confirm the access token works.",
  inputSchema: {},
  outputSchema: {
    user: z
      .object({ id: z.string().describe("YNAB user id, a UUID.") })
      .describe("The authenticated YNAB user."),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(_args, { client }) {
    const { data } = await client.api.user.getUser();
    return { user: { id: data.user.id } };
  },
});
