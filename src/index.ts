#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_TTL_MS, withCache } from "./cache.ts";
import { ConfigError, createClient } from "./client.ts";
import { connect, createServer, NAME, VERSION } from "./server.ts";

/** The flag that serves the read surface alone. `YNAB_READ_ONLY` does the same. */
const READ_ONLY_FLAG = "--read-only";

/** How long a read stays fresh, in seconds. `0` serves every read from YNAB. */
const CACHE_TTL_ENV = "YNAB_CACHE_TTL_SECONDS";

async function main(): Promise<void> {
  // Before the transport: a missing token must kill the process, not leave a
  // server whose every call 401s.
  const client = createClient();
  const readOnly = readOnlyRequested();
  const ttlMs = cacheTtlMs(process.env[CACHE_TTL_ENV]);

  // Wrapped here rather than in `createServer`, which reads nothing from the
  // environment — see AGENTS.md, "Startup".
  const served = withCache(client, { ttlMs });

  await connect(createServer(served, { readOnly }), new StdioServerTransport());

  const mode = readOnly ? ", read-only" : "";
  const cache = ttlMs > 0 ? `${ttlMs / 1000}s cache` : "no cache";
  console.error(
    `${NAME} ${VERSION} on stdio${mode}, ${cache} — default plan: ${client.resolvePlanId()}`,
  );
}

/** Whether this process was asked for the read surface alone, by flag or by environment. */
function readOnlyRequested(): boolean {
  return flagAsks(process.argv.slice(2)) || isOn(process.env.YNAB_READ_ONLY);
}

/**
 * Whether `--read-only` was passed, alone or with a value. Anything else on the
 * command line stops the process — a near-miss must not read as "no".
 */
function flagAsks(args: readonly string[]): boolean {
  let asked = false;
  for (const arg of args) {
    const [name = "", ...value] = arg.split("=");
    if (name !== READ_ONLY_FLAG) {
      throw new ConfigError(
        `unknown argument ${JSON.stringify(arg)}. The only flag this server takes is ` +
          `${READ_ONLY_FLAG}, which serves the read surface alone.`,
      );
    }
    asked ||= value.length === 0 || isOn(value.join("="));
  }
  return asked;
}

/**
 * The freshness window in milliseconds. A bad value stops the process rather
 * than falling back: a typo that silently disabled caching would show up only
 * as an unexplained 429 an hour later.
 */
function cacheTtlMs(value: string | undefined): number {
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
 * Whether a setting asks for something. Anything but absent, blank, `0` or `false`
 * counts as yes — see AGENTS.md, "Read-only mode", on why this one errs towards
 * being set. Shared by the flag and the variable so the two cannot disagree.
 */
function isOn(value: string | undefined): boolean {
  const setting = value?.trim().toLowerCase();
  if (setting === undefined || setting === "") return false;
  return setting !== "0" && setting !== "false";
}

main().catch((error: unknown) => {
  // stdout is the JSON-RPC channel — diagnostics must go to stderr.
  if (error instanceof ConfigError) {
    console.error(`${NAME}: ${error.message}`);
  } else {
    console.error(`${NAME}: fatal:`, error);
  }
  process.exit(1);
});
