#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout is the JSON-RPC channel — diagnostics must go to stderr.
  console.error(`${NAME}: fatal:`, error);
  process.exit(1);
});
