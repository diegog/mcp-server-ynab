#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, createClient } from "./client.ts";

const NAME = "mcp-server-ynab";
const VERSION = "0.1.0";

/**
 * Install the tools/list and tools/call handlers, which McpServer wires lazily
 * on first `registerTool`. See AGENTS.md, "Startup". Delete once real tools
 * register (ENG-22).
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
  // Before the transport: a missing token must kill the process, not leave a
  // server whose every call 401s.
  const client = createClient();

  const server = createServer();
  await server.connect(new StdioServerTransport());

  console.error(`${NAME} ${VERSION} on stdio — default plan: ${client.resolvePlanId()}`);
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
