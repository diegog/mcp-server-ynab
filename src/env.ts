/**
 * The settings both entrypoints read, parsed the same way by each. Lifted out
 * of `index.ts` when the remote entrypoint arrived, for the reason
 * `arguments.ts` exists: a rule spelled one way over stdio and another over
 * HTTP is worse than one spelled once.
 */
import { DEFAULT_TTL_MS } from "./cache.ts";
import { ConfigError } from "./client.ts";

/** How long a read stays fresh, in seconds. `0` serves every read from YNAB. */
export const CACHE_TTL_ENV = "YNAB_CACHE_TTL_SECONDS";

/** Serve the read surface alone. `--read-only` asks the stdio server the same. */
export const READ_ONLY_ENV = "YNAB_READ_ONLY";

/**
 * Whether a setting asks for something. Anything but absent, blank, `0` or
 * `false` counts as yes — see AGENTS.md, "Read-only mode", on why this one errs
 * towards being set. Shared by the flag and the variable so the two cannot
 * disagree.
 */
export function isOn(value: string | undefined): boolean {
  const setting = value?.trim().toLowerCase();
  if (setting === undefined || setting === "") return false;
  return setting !== "0" && setting !== "false";
}

/**
 * The freshness window in milliseconds. A bad value stops the process rather
 * than falling back: a typo that silently disabled caching would show up only
 * as an unexplained 429 an hour later.
 */
export function cacheTtlMs(value: string | undefined): number {
  const setting = value?.trim();
  if (setting === undefined || setting === "") return DEFAULT_TTL_MS;

  const seconds = Number(setting);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new ConfigError(
      `${CACHE_TTL_ENV} is ${JSON.stringify(setting)}, which is not a number of seconds. ` +
        `Give a whole number, or 0 to send every read to YNAB.`,
    );
  }
  return seconds * 1000;
}

/**
 * A TCP port from the environment. Named rather than fixed because the remote
 * entrypoint is configured entirely by environment, and a port that silently
 * fell back to a default would bind somewhere the orchestrator is not looking.
 */
export function port(value: string | undefined, fallback: number, name: string): number {
  const setting = value?.trim();
  if (setting === undefined || setting === "") return fallback;

  const parsed = Number(setting);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new ConfigError(
      `${name} is ${JSON.stringify(setting)}, which is not a port number. ` +
        "Give a whole number between 1 and 65535.",
    );
  }
  return parsed;
}
