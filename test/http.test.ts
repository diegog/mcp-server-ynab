/**
 * The remote entrypoint over a real socket. Driven with the SDK's own client
 * rather than hand-built JSON-RPC, for the reason the in-memory harness is:
 * a test that does not speak the protocol cannot fail where a client would.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createApp } from "../src/http.ts";
import { fakeClient, type Replies } from "./helpers/fake-client.ts";

const USER: Replies = { "user.getUser": { data: { user: { id: "user-1" } } } };

interface Served {
  /** Where the app is listening, without a path. */
  readonly origin: string;
  close(): Promise<void>;
}

/** Bind the real app on an ephemeral port with a faked YNAB behind it. */
async function serve(replies: Replies = {}, readOnly?: boolean): Promise<Served> {
  const app = createApp({
    client: fakeClient(replies),
    ...(readOnly === undefined ? {} : { readOnly }),
  });
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      // Keep-alive sockets would otherwise hold `close` open past the test.
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** A connected MCP client, and the teardown for both ends. */
async function connected(replies: Replies = {}, readOnly?: boolean) {
  const served = await serve(replies, readOnly);
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${served.origin}/mcp`));
  // Cast for the same `exactOptionalPropertyTypes` mismatch `src/http.ts`
  // explains: the HTTP transports type `sessionId` as `string | undefined`
  // where `Transport` has it optional.
  await client.connect(transport as unknown as Transport);

  return {
    client,
    served,
    close: async () => {
      await client.close();
      await served.close();
    },
  };
}

describe("the remote entrypoint", () => {
  it("serves the tool surface to a real MCP client", async () => {
    const test = await connected(USER);
    try {
      const { tools } = await test.client.listTools();
      assert.ok(tools.length > 0, "tools/list came back empty");
      assert.ok(
        tools.some((tool) => tool.name === "create_transaction"),
        "the write surface is missing from a read-write server",
      );
    } finally {
      await test.close();
    }
  });

  it("runs a tool call through to the client", async () => {
    const test = await connected(USER);
    try {
      const result = await test.client.callTool({ name: "get_user" });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.deepEqual(result.structuredContent, { user: { id: "user-1" } });
    } finally {
      await test.close();
    }
  });

  it("serves the resource layer over the same endpoint", async () => {
    const test = await connected(USER);
    try {
      const { contents } = await test.client.readResource({ uri: "ynab://user" });
      const [content] = contents;
      assert.equal(content?.uri, "ynab://user");
      assert.ok(content && "text" in content, "the resource came back without a text body");
      assert.deepEqual(JSON.parse(content.text), { user: { id: "user-1" } });
    } finally {
      await test.close();
    }
  });

  it("withholds the write surface when the connection is read-only", async () => {
    // Same rule as stdio: filtered before registration, never registered and
    // disabled — see AGENTS.md, "Read-only mode".
    const test = await connected(USER, true);
    try {
      const { tools } = await test.client.listTools();
      assert.ok(tools.length > 0);
      assert.equal(
        tools.filter((tool) => tool.annotations?.readOnlyHint !== true).length,
        0,
        "a write tool was served to a read-only connection",
      );
    } finally {
      await test.close();
    }
  });

  it("issues no session id, because it keeps no session", async () => {
    // Statelessness is the security posture, not a simplification: there is no
    // session to hijack and every request carries its own authorization.
    const served = await serve(USER);
    try {
      const response = await fetch(`${served.origin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("mcp-session-id"), null);
      await response.body?.cancel();
    } finally {
      await served.close();
    }
  });

  it("answers /healthz without touching YNAB", async () => {
    // No replies configured: `fakeClient` throws on any call, so a probe that
    // reached the API would fail here rather than pass quietly.
    const served = await serve();
    try {
      const response = await fetch(`${served.origin}/healthz`);
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { status: string }).status, "ok");
    } finally {
      await served.close();
    }
  });

  it("refuses GET and DELETE on /mcp", async () => {
    const served = await serve();
    try {
      for (const method of ["GET", "DELETE"]) {
        const response = await fetch(`${served.origin}/mcp`, { method });
        assert.equal(response.status, 405, `${method} was not refused`);
        assert.equal(response.headers.get("allow"), "POST");
        await response.body?.cancel();
      }
    } finally {
      await served.close();
    }
  });
});
