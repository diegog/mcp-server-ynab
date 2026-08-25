#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, createClient } from "./client.ts";
import { connect, createServer, NAME, VERSION } from "./server.ts";

/** The flag that serves the read surface alone. `YNAB_READ_ONLY` does the same. */
const READ_ONLY_FLAG = "--read-only";

async function main(): Promise<void> {
  // Before the transport: a missing token must kill the process, not leave a
  // server whose every call 401s.
  const client = createClient();
  const readOnly = readOnlyRequested();

  await connect(createServer(client, { readOnly }), new StdioServerTransport());

  const mode = readOnly ? ", read-only" : "";
  console.error(`${NAME} ${VERSION} on stdio${mode} — default plan: ${client.resolvePlanId()}`);
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
