/**
 * A live server over an in-memory transport, so a test exercises the same path
 * a client does: schema validation, the registry's result building, and the
 * error mapping around it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connect, createServer } from "../../src/server.ts";
import { type FakeClient, fakeClient, type Replies } from "./fake-client.ts";

export interface Harness {
  readonly client: Client;
  readonly ynab: FakeClient;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/**
 * Connect a client to a server built on a faked YNAB. Always through
 * `connect`, never `server.connect` — see AGENTS.md, "Omitted tool arguments".
 */
export async function harness(
  replies: Replies = {},
  options: { readonly readOnly?: boolean } = {},
): Promise<Harness> {
  const ynab = fakeClient(replies);
  const server = createServer(ynab, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test", version: "0" });
  await Promise.all([connect(server, serverTransport), client.connect(clientTransport)]);

  return {
    client,
    ynab,
    async call(name, args) {
      return (await client.callTool({
        name,
        ...(args === undefined ? {} : { arguments: args }),
      })) as CallToolResult;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** The text of a tool result, which is where both data and failures land. */
export function textOf(result: CallToolResult): string {
  const [first] = result.content;
  return first !== undefined && first.type === "text" ? first.text : "";
}
