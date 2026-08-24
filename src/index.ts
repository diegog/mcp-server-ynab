#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, createClient } from "./client.ts";

const NAME = "mcp-server-ynab";
const VERSION = "0.1.0";

/**
 * Declare the `tools` capability and install the tools/list + tools/call
 * handlers before any real tool exists.
 *
 * McpServer wires those handlers lazily, on first `registerTool`. With an empty
 * registry it would answer tools/list with -32601 and advertise no capability,
 * so a client could not tell an empty server from a broken one. Registering a
 * placeholder and immediately removing it runs that wiring; `remove()` drops the
 * entry but leaves the handlers in place, and tools/list then returns [].
 *
 * Delete this once the tool registry lands (ENG-22) and real tools register.
 */
function declareToolsCapability(server: McpServer): void {
  server.registerTool("__placeholder", { description: "" }, () => ({ content: [] })).remove();
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    {
      instructions:
        "Read and modify a YNAB budget. YNAB calls a budget a 'plan'; most tools take a planId.",
    },
  );
  declareToolsCapability(server);
  return server;
}

async function main(): Promise<void> {
  // Before the transport comes up, so a missing token kills the process with a
  // readable reason instead of leaving a server whose every call 401s. The
  // client is threaded into tool handlers when the registry lands (ENG-22).
  const client = createClient();

  const server = createServer();
  await server.connect(new StdioServerTransport());

  // stderr, never stdout — and never the token. The resolved default is worth
  // saying out loud: it is what every tool call that omits plan_id will use.
  console.error(`${NAME} ${VERSION} on stdio — default plan: ${client.resolvePlanId()}`);
}

main().catch((error: unknown) => {
  // stdout is the JSON-RPC channel — diagnostics must go to stderr.
  if (error instanceof ConfigError) {
    // The user's own misconfiguration; a stack trace would only bury it.
    console.error(`${NAME}: ${error.message}`);
  } else {
    console.error(`${NAME}: fatal:`, error);
  }
  process.exit(1);
});
