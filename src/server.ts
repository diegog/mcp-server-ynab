import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { YnabClient } from "./client.ts";
import { registerResources } from "./resources.ts";
import { TOOLS } from "./tools/index.ts";
import { type AnyToolDefinition, registerTools } from "./tools/registry.ts";

/** The name and version reported in the MCP handshake. */
export const NAME = "mcp-server-ynab";
export const VERSION = "0.1.0";

/** What a server serves, beyond the client it reaches YNAB through. */
export interface ServerOptions {
  /** Serve the read surface alone. See AGENTS.md, "Read-only mode". */
  readonly readOnly?: boolean;
}

/**
 * Build the server, registering the tools it serves against `client` — the read
 * surface alone when `readOnly`. No transport is attached and nothing is read from
 * the environment, per AGENTS.md, "Startup" and "Read-only mode".
 */
export function createServer(client: YnabClient, options: ServerOptions = {}): McpServer {
  const readOnly = options.readOnly ?? false;
  const server = new McpServer(
    { name: NAME, version: VERSION },
    { instructions: instructionsFor(readOnly) },
  );
  // Filtered before registration, never registered and disabled: see AGENTS.md,
  // "Read-only mode".
  registerTools(server, readOnly ? TOOLS.filter(reads) : TOOLS, { client });
  // A second surface over the same handlers, and reads only — see AGENTS.md,
  // "The resource layer". Registered before `connect` for the reason the tools
  // are: `McpServer` throws if a capability is added after a transport.
  registerResources(server, TOOLS.filter(reads), { client });
  return server;
}

/** Whether a tool only reads. Total, because `readOnlyHint` is required on every tool. */
function reads(tool: AnyToolDefinition): boolean {
  return tool.annotations.readOnlyHint;
}

/** The handshake's one chance to say what this server is and what it will not do. */
function instructionsFor(readOnly: boolean): string {
  const surface = readOnly
    ? "Read a YNAB budget. This server is running read-only and serves no tool that " +
      "creates, changes or deletes anything."
    : "Read and modify a YNAB budget.";
  return (
    `${surface} YNAB calls a budget a 'plan'; most tools take an optional plan_id, and ` +
    "omitting it acts on the plan the server was configured with, or the one most recently " +
    "opened in YNAB."
  );
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
