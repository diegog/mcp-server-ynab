#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, createClient } from "./client.ts";
import { connect, createServer, NAME, VERSION } from "./server.ts";

async function main(): Promise<void> {
  // Before the transport: a missing token must kill the process, not leave a
  // server whose every call 401s.
  const client = createClient();

  await connect(createServer(client), new StdioServerTransport());

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
