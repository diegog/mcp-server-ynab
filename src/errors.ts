/**
 * Turn a failed tool call into text the model can act on. See AGENTS.md,
 * "Error mapping".
 */

/** Context the registry supplies so a message can name what failed. */
export interface FailureContext {
  readonly tool: string;
  /** The raw arguments, so a not-found message can echo the ids that were used. */
  readonly args: unknown;
}

/** A failure this server raised deliberately; its message is already actionable. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** The body YNAB returns on any non-2xx. @see https://api.ynab.com/#errors */
interface YnabFailure {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
}

/** Argument names worth echoing back when YNAB says something was not found. */
const ID_ARGUMENT = /(?:^|_)id$|^month$/;

/** Describe `error` for the model, as the text of an `isError` tool result. */
export function describeFailure(error: unknown, { tool, args }: FailureContext): string {
  return `${tool}: ${explain(error, args)}`;
}

function explain(error: unknown, args: unknown): string {
  if (error instanceof ToolError) return error.message;

  const failure = asYnabFailure(error);
  if (failure !== undefined) {
    return `${advise(failure, args)} (YNAB error ${failure.id} ${failure.name}: ${failure.detail})`;
  }

  if (isNetworkFailure(error)) {
    return (
      "could not reach api.ynab.com. This is a network or DNS failure on the machine running " +
      `the server, not something YNAB rejected: ${describeCause(error)}. Retryable once ` +
      "connectivity is back; nothing was sent, so no record was changed."
    );
  }

  // The SDK parses every response body as JSON, so a maintenance or proxy page
  // surfaces as a parse failure rather than as a YNAB error.
  if (error instanceof SyntaxError) {
    return (
      "YNAB returned a response that was not JSON, which usually means a proxy or maintenance " +
      `page rather than the API itself (${error.message}). Retryable after a pause.`
    );
  }

  return (
    `failed unexpectedly: ${messageOf(error)}. YNAB did not reject the request — this is a bug ` +
    "in the server, so retrying the same call will fail the same way."
  );
}

/**
 * The advice for one YNAB failure. Sub-codes are matched before the status so
 * that, say, a lapsed subscription reads differently from an expired trial.
 */
function advise(failure: YnabFailure, args: unknown): string {
  switch (failure.id) {
    case "403.1":
      return (
        "the YNAB subscription on this account has lapsed, so the API is refusing access. No " +
        "tool will work until the account holder renews at https://app.ynab.com/settings. " +
        "Do not retry."
      );
    case "403.2":
      return (
        "the YNAB trial on this account has expired, so the API is refusing access. No tool " +
        "will work until the account holder subscribes at https://app.ynab.com/settings. " +
        "Do not retry."
      );
    case "403.3":
      return (
        "the access token lacks the scope this request needs. A Personal Access Token carries " +
        "full scope, so the server was most likely given an OAuth token instead. Do not retry."
      );
    case "403.4":
      return (
        "the request would exceed a YNAB data limit. Ask for less in one call — narrow the date " +
        "range, or fetch a single record instead of a whole list."
      );
    case "404.1":
      return (
        "that endpoint does not exist at YNAB. The ids are not at fault; the server built a URL " +
        "the API does not serve, which is a bug in the server. Do not retry."
      );
    default:
      break;
  }

  // "403.1" and the like parse to their status, which is what the rest turn on.
  switch (Number.parseInt(failure.id, 10)) {
    case 400:
      return (
        "YNAB rejected the arguments as malformed. Dates must be ISO `YYYY-MM-DD`, ids must be " +
        `UUIDs taken from a list tool, and amounts are integer milliunits.${idsIn(args)} Fix ` +
        "the arguments rather than retrying as sent."
      );
    case 401:
      return (
        "the YNAB access token is missing, invalid, revoked, or expired. The server reads it " +
        "from `YNAB_ACCESS_TOKEN` in its own environment at startup, so no tool argument and no " +
        "retry can fix it: the account holder has to put a valid Personal Access Token from " +
        "https://app.ynab.com/settings/developer into this server's MCP client configuration " +
        "and restart it."
      );
    case 403:
      return (
        "YNAB refused the request. This is an account-level restriction rather than anything " +
        "about the arguments, so retrying will not help."
      );
    case 404:
      return (
        "YNAB has no such record, so at least one id does not exist in the plan that was used." +
        `${idsIn(args)} YNAB does not say which one. Re-list the entities to get current ids ` +
        "rather than guessing, and note that an omitted `plan_id` resolves to the server's " +
        "default plan, which may not be the plan holding the other ids."
      );
    case 409:
      return (
        "YNAB refused to save this because it conflicts with a record that already exists. On " +
        "a transaction this is nearly always a duplicate `import_id`, which YNAB requires to be " +
        "unique within a plan — the earlier transaction is the one that stuck, so treat this " +
        `call as already done.${idsIn(args)} Do not retry with the same values.`
      );
    case 429:
      return (
        "YNAB is rate limiting this token. The allowance is 200 requests per hour, counted over " +
        "a rolling window: it does not reset on the hour, it recovers gradually as individual " +
        "requests age past sixty minutes. Retrying now will fail again and buy nothing. Wait " +
        "several minutes before a single retry, and expect to wait up to an hour if the " +
        "allowance went in one burst. YNAB stopped returning the `X-Rate-Limit` header on 429s, " +
        "so how much is left cannot be reported. Until this clears, avoid calls that fan out " +
        "over several requests, and tell the user rather than retrying in a loop."
      );
    case 500:
      return (
        "YNAB hit an unexpected error on its side. If this call writes, the write may still " +
        "have landed — read the record back before sending it again. Otherwise retry once " +
        "after a short pause."
      );
    case 503:
      return (
        "YNAB is temporarily unavailable: heavy load, maintenance, or a request that ran past " +
        "its thirty-second limit. Retry once after a pause, asking for less if the call was a " +
        "large list."
      );
    default:
      return "YNAB rejected the request.";
  }
}

/**
 * The ids the call was given. YNAB never says which id it could not find, and
 * these are the candidates.
 */
function idsIn(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const named = Object.entries(args as Record<string, unknown>)
    .filter(([key, value]) => ID_ARGUMENT.test(key) && typeof value === "string" && value !== "")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return named.length === 0 ? "" : ` Ids passed: ${named.join(", ")}.`;
}

/** The SDK throws the parsed error body itself, so this is a shape test, not `instanceof`. */
function asYnabFailure(error: unknown): YnabFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const body = (error as { error?: unknown }).error;
  if (typeof body !== "object" || body === null) return undefined;
  const { id, name, detail } = body as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string" || typeof detail !== "string") {
    return undefined;
  }
  return { id, name, detail };
}

/** `fetch` reports a dead connection as a bare `TypeError`; the SDK wraps it only with middleware. */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === "FetchError");
}

function describeCause(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? messageOf(error) : `${messageOf(error)}: ${messageOf(cause)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
