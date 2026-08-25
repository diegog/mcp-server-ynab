/**
 * Arguments more than one tool takes. See AGENTS.md, "Shared tool arguments".
 */
import { z } from "zod";

/** The literal that asks YNAB for the current calendar month, in UTC. */
export const CURRENT_MONTH = "current";

/** Said wherever a tool takes an id, so no tool invents a plausible one instead. */
function lookedUpWith(tool: string): string {
  return `Ids are opaque strings YNAB assigns; get one from \`${tool}\` rather than guessing it.`;
}

/**
 * The plan a tool acts on. Optional here rather than at each call site, because
 * it is optional on every tool without exception.
 * @see https://api.ynab.com/#endpoints
 */
export function planIdArgument(): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .describe(
      "Id of the plan (YNAB's name for a budget) to act on. Omit it unless the user " +
        "named a particular plan: the server then uses the plan it was configured with, " +
        "falling back to the one most recently opened in YNAB. " +
        lookedUpWith("list_plans"),
    )
    .optional();
}

/**
 * A plan month, optional at every call site so far. `meaning` says which month
 * the tool wants it for.
 * @see https://api.ynab.com/#formats
 */
export function monthArgument(meaning: string): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .describe(
      `${meaning} A plan month, written as the first day of that month: 2016-12-01 for ` +
        `December 2016. The literal "${CURRENT_MONTH}" selects the current calendar ` +
        "month in UTC, and is the only literal YNAB accepts here.",
    )
    .optional();
}

/**
 * An id of some other YNAB record. `tool` is the tool that lists them. Unlike
 * the two above this is required, since an id is a filter on some tools and the
 * subject of others — add `.optional()` where it is a filter.
 */
export function idArgument(meaning: string, tool: string): z.ZodString {
  // A bare string, never `z.uuid()`: see AGENTS.md, "The tool registry", on
  // output schemas staying as loose as YNAB's own guarantee. The same applies
  // here, where a stricter schema rejects the call before it is made.
  return z.string().describe(`${meaning} ${lookedUpWith(tool)}`);
}
