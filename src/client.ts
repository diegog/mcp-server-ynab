import { api as Ynab } from "ynab";

/**
 * The authenticated YNAB SDK object. Tool modules take a `YnabClient` and reach
 * the SDK through it, so `ynab` is imported in exactly one place.
 */
export type YnabApi = Ynab;

const TOKEN_ENV = "YNAB_ACCESS_TOKEN";
const DEFAULT_PLAN_ENV = "YNAB_DEFAULT_PLAN_ID";

/**
 * The API accepts this literal wherever a plan id is expected and resolves it to
 * the plan the user most recently opened. That makes it a free final fallback —
 * no extra request to look an id up, and no guessing when the user has several
 * plans.
 */
export const LAST_USED_PLAN_ID = "last-used";

/**
 * A startup misconfiguration — something the user has to fix in their
 * environment. Reported as a plain message, not a stack trace.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface YnabClient {
  /** The SDK, already authenticated: `client.api.plans.getPlans()`. */
  readonly api: YnabApi;
  /**
   * The plan id a tool call should use: the explicit argument if it has one,
   * else `YNAB_DEFAULT_PLAN_ID`, else `"last-used"`. `plan_id` is optional on
   * every tool, so every handler that needs one goes through here.
   */
  resolvePlanId(planId?: string): string;
}

/**
 * Build the client from the environment. Throws `ConfigError` if the access
 * token is missing, so the process dies at startup rather than serving a tool
 * surface where every call 401s.
 *
 * The token stays local to this function — it goes straight into the SDK and is
 * never stored on the returned client, logged, or put in an error message.
 */
export function createClient(env: NodeJS.ProcessEnv = process.env): YnabClient {
  const token = provided(env[TOKEN_ENV]);
  if (token === undefined) {
    throw new ConfigError(
      `${TOKEN_ENV} is not set. Create a YNAB Personal Access Token at ` +
        "https://app.ynab.com/settings/developer and pass it to the server in the " +
        "environment — see .env.example.",
    );
  }

  const fallbackPlanId = provided(env[DEFAULT_PLAN_ENV]) ?? LAST_USED_PLAN_ID;

  return {
    api: new Ynab(token),
    resolvePlanId: (planId) => provided(planId) ?? fallbackPlanId,
  };
}

/**
 * Treat blank as absent. An env var set to the empty string and a model passing
 * `plan_id: ""` should both fall through to the next fallback rather than
 * becoming a request for a plan named "".
 */
function provided(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
