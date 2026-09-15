/**
 * The remote entrypoint over a real socket. Driven with the SDK's own client
 * rather than hand-built JSON-RPC, for the reason the in-memory harness is:
 * a test that does not speak the protocol cannot fail where a client would.
 * Every connection here is authenticated first; the flow itself is tested in
 * `oauth.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { accessToken, type Remote, type RemoteOptions, remote } from "./helpers/remote.ts";

/** A connected MCP client, authenticated, and the teardown for both ends. */
async function connected(options: RemoteOptions = {}, scope?: string) {
  const served = await remote(options);
  const client = new Client({ name: "test", version: "0" });
  try {
    const { access } = await accessToken(served, scope === undefined ? {} : { scope });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", served.origin), {
      requestInit: { headers: { authorization: `Bearer ${access}` } },
    });
    // Cast for the same `exactOptionalPropertyTypes` mismatch `src/http.ts`
    // explains: the HTTP transports type `sessionId` as `string | undefined`
    // where `Transport` has it optional.
    await client.connect(transport as unknown as Transport);
  } catch (error) {
    // A server left listening keeps the runner alive past a failed setup.
    await served.close();
    throw error;
  }

  return {
    client,
    served,
    close: async () => {
      await client.close();
      await served.close();
    },
  };
}

/** `POST /mcp` by hand, with or without a token. */
function post(served: Remote, body: unknown, access?: string): Promise<Response> {
  return fetch(new URL("/mcp", served.origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(access === undefined ? {} : { authorization: `Bearer ${access}` }),
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

describe("the remote entrypoint", () => {
  it("serves the tool surface to a real MCP client", async () => {
    const test = await connected();
    try {
      const { tools } = await test.client.listTools();
      assert.ok(tools.length > 0, "tools/list came back empty");
      assert.ok(
        tools.some((tool) => tool.name === "create_transaction"),
        "the write surface is missing from a read-write connection",
      );
    } finally {
      await test.close();
    }
  });

  it("runs a tool call through to the caller's own client", async () => {
    const test = await connected();
    try {
      const result = await test.client.callTool({ name: "get_user" });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.deepEqual(result.structuredContent, { user: { id: "user-1" } });
    } finally {
      await test.close();
    }
  });

  it("serves the resource layer over the same endpoint", async () => {
    const test = await connected();
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

  it("withholds the write surface when the server is read-only for everyone", async () => {
    // Same rule as stdio: filtered before registration, never registered and
    // disabled — see AGENTS.md, "Read-only mode". Scope tests live in oauth.test.ts.
    const test = await connected({ readOnly: true });
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
    const served = await remote();
    try {
      const { access } = await accessToken(served);
      const response = await post(served, INITIALIZE, access);
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
    const served = await remote({ replies: {} });
    try {
      const response = await fetch(new URL("/healthz", served.origin));
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { status: string }).status, "ok");
    } finally {
      await served.close();
    }
  });

  it("refuses GET and DELETE on /mcp", async () => {
    const served = await remote();
    try {
      for (const method of ["GET", "DELETE"]) {
        const response = await fetch(new URL("/mcp", served.origin), { method });
        assert.equal(response.status, 405, `${method} was not refused`);
        assert.equal(response.headers.get("allow"), "POST");
        await response.body?.cancel();
      }
    } finally {
      await served.close();
    }
  });
});
