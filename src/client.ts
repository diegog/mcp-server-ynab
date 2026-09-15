import { api as Ynab } from "ynab";

/** The authenticated YNAB SDK object. */
export type YnabApi = Ynab;

const TOKEN_ENV = "YNAB_ACCESS_TOKEN";
const DEFAULT_PLAN_ENV = "YNAB_DEFAULT_PLAN_ID";

/**
 * Plan id the API resolves to the user's most recently opened plan.
 * @see https://api.ynab.com/#endpoints
 */
export const LAST_USED_PLAN_ID = "last-used";

/** A missing or unusable environment variable. See AGENTS.md, "Startup". */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface YnabClient {
  /** The SDK, already authenticated: `client.api.plans.getPlans()`. */
  readonly api: YnabApi;
  /** Explicit argument, else `YNAB_DEFAULT_PLAN_ID`, else {@link LAST_USED_PLAN_ID}. */
  resolvePlanId(planId?: string): string;
}

/**
 * Build the client from the environment, throwing {@link ConfigError} when the
 * access token is absent. See AGENTS.md, "The client module".
 * @see https://api.ynab.com/#personal-access-tokens
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
 * A client whose token is resolved on every request, for the remote entrypoint
 * where the token is a user's OAuth grant that refreshes under it. Nothing
 * captures the token: `getToken` is asked each time, and the SDK awaits it per
 * request. See AGENTS.md, "The remote surface".
 */
export function clientForToken(
  getToken: () => Promise<string>,
  options: { readonly defaultPlanId?: string | undefined } = {},
): YnabClient {
  const fallbackPlanId = provided(options.defaultPlanId) ?? LAST_USED_PLAN_ID;
  return {
    // The constructor is typed for a string but assigns straight into
    // `Configuration({ accessToken })`, which accepts a function and calls it
    // per request. The cast is checked in test/upstream.test.ts.
    api: new Ynab(getToken as unknown as string),
    resolvePlanId: (planId) => provided(planId) ?? fallbackPlanId,
  };
}

/** Blank counts as absent, so it falls through to the next fallback. */
function provided(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
