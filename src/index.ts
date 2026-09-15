#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { withCache } from "./cache.ts";
import { ConfigError, createClient } from "./client.ts";
import { CACHE_TTL_ENV, cacheTtlMs, isOn, READ_ONLY_ENV } from "./env.ts";
import { connect, createServer, NAME, VERSION } from "./server.ts";

/** The flag that serves the read surface alone. `YNAB_READ_ONLY` does the same. */
const READ_ONLY_FLAG = "--read-only";

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
  return flagAsks(process.argv.slice(2)) || isOn(process.env[READ_ONLY_ENV]);
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

main().catch((error: unknown) => {
  // stdout is the JSON-RPC channel — diagnostics must go to stderr.
  if (error instanceof ConfigError) {
    console.error(`${NAME}: ${error.message}`);
  } else {
    console.error(`${NAME}: fatal:`, error);
  }
  process.exit(1);
});
