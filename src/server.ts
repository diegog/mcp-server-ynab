import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { YnabClient } from "./client.ts";
import { TOOLS } from "./tools/index.ts";
import { registerTools } from "./tools/registry.ts";

/** The name and version reported in the MCP handshake. */
export const NAME = "mcp-server-ynab";
export const VERSION = "0.1.0";

/**
 * Build the server with every tool registered against `client`. No transport is
 * attached and nothing is read from the environment — see AGENTS.md, "Startup".
 */
export function createServer(client: YnabClient): McpServer {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    {
      instructions:
        "Read and modify a YNAB budget. YNAB calls a budget a 'plan'; most tools take a planId.",
    },
  );
  registerTools(server, TOOLS, { client });
  return server;
}

/**
 * Attach `transport` and work around the SDK dropping `tools/call` requests that
 * omit `arguments`. Always connect through this, never `server.connect` — see
 * AGENTS.md, "Omitted tool arguments".
 */
export async function connect(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(transport);

  // `server.connect` installs the real handler; wrap it rather than replace it.
  const deliver = transport.onmessage;
  transport.onmessage = (message, extra) => {
    defaultToolArguments(message);
    deliver?.(message, extra);
  };
}

/** @see https://github.com/modelcontextprotocol/typescript-sdk/issues/400 */
function defaultToolArguments(message: unknown): void {
  if (message === null || typeof message !== "object") return;
  const request = message as { method?: unknown; params?: { arguments?: unknown } };
  if (request.method !== "tools/call" || request.params === undefined) return;
  request.params.arguments ??= {};
}
