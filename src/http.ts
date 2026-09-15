#!/usr/bin/env node
/**
 * The same tool surface over Streamable HTTP, for clients that cannot spawn a
 * process — claude.ai on the web and on mobile reach a URL, not a laptop. This
 * file is `index.ts` for the network: it reads the environment, binds a port,
 * and owns everything that only makes sense in a real process.
 *
 * See AGENTS.md, "The remote surface".
 */
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Express, Request, Response } from "express";
import { withCache } from "./cache.ts";
import { ConfigError, createClient, type YnabClient } from "./client.ts";
import { CACHE_TTL_ENV, cacheTtlMs, isOn, port, READ_ONLY_ENV } from "./env.ts";
import { connect, createServer, NAME, VERSION } from "./server.ts";

const PORT_ENV = "PORT";
const HOST_ENV = "HOST";

/** The port bound when `PORT` says nothing. 8080, because the process is not root. */
const DEFAULT_PORT = 8080;

/** Loopback, because this entrypoint has no authentication yet — see `main`. */
const DEFAULT_HOST = "127.0.0.1";

/** What the app serves. Nothing here is read from the environment. */
export interface AppOptions {
  /** The YNAB client every request is served through. */
  readonly client: YnabClient;
  /** Serve the read surface alone. See AGENTS.md, "Read-only mode". */
  readonly readOnly?: boolean;
  /** Bind address, which decides whether DNS rebinding protection applies. */
  readonly host?: string;
}

/**
 * Build the Express app. Reads nothing from the environment and binds no port,
 * so a test can drive the real routes over `listen(0)` — the same seam
 * `createServer` is for the tools.
 */
export function createApp(options: AppOptions): Express {
  const app = createMcpExpressApp({ host: options.host ?? DEFAULT_HOST });

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok", name: NAME, version: VERSION });
  });

  app.post("/mcp", (request, response) => {
    void serve(request, response, options);
  });

  // Stateless means there is no standalone stream to open and no session to
  // delete, so both are refused rather than left to answer confusingly.
  app.all("/mcp", (_request, response) => {
    response
      .status(405)
      .set("Allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. This endpoint takes POST." },
        id: null,
      });
  });

  return app;
}

/**
 * Answer one request with its own server and transport.
 *
 * **Stateless**, per AGENTS.md: the transport generates no session id, so there
 * is none to steal, and every request has to carry its own authorization rather
 * than inheriting a session's. A fresh `McpServer` per request is what lets the
 * tool surface be decided per caller — read-only is a property of the caller
 * once it arrives as a scope, and a withheld tool is never registered rather
 * than registered and disabled. It is affordable because `registerTool` only
 * files the zod shapes in a map: JSON Schema conversion happens later, inside
 * the `tools/list` handler.
 */
async function serve(request: Request, response: Response, options: AppOptions): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    // No `sessionIdGenerator`: an absent one *is* stateless mode, and the SDK
    // requires a fresh transport per request when it is absent. Passing an
    // explicit `undefined` says the same thing but fails
    // `exactOptionalPropertyTypes`.
    //
    // Nothing here streams: no progress, no server-initiated notification, and
    // a per-request server has no later moment to send one from. A plain JSON
    // body is what survives an intermediary that buffers.
    enableJsonResponse: true,
  });
  const server = createServer(
    options.client,
    options.readOnly === undefined ? {} : { readOnly: options.readOnly },
  );

  response.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    // Through `connect`, never `server.connect`: the omitted-`arguments`
    // workaround is about the SDK's request parsing, not about stdio.
    //
    // The cast is an `exactOptionalPropertyTypes` mismatch and nothing more:
    // `Transport` declares `onclose?: () => void`, which `StdioServerTransport`
    // matches, while the HTTP transports expose it as an accessor typed
    // `(() => void) | undefined`. Same runtime contract, incompatible spelling.
    await connect(server, transport as unknown as Transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    console.error(`${NAME}: request failed:`, error);
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error." },
        id: null,
      });
    }
  }
}

async function main(): Promise<void> {
  // Before the port: a missing token must kill the process, not leave a server
  // whose every call 401s.
  const client = createClient();
  const readOnly = isOn(process.env[READ_ONLY_ENV]);
  const ttlMs = cacheTtlMs(process.env[CACHE_TTL_ENV]);
  const host = process.env[HOST_ENV]?.trim() || DEFAULT_HOST;
  const bind = port(process.env[PORT_ENV], DEFAULT_PORT, PORT_ENV);

  // Wrapped here rather than in `createApp`, which reads nothing from the
  // environment — the same split `index.ts` makes.
  const app = createApp({ client: withCache(client, { ttlMs }), readOnly, host });

  const listener = app.listen(bind, host, () => {
    const mode = readOnly ? ", read-only" : "";
    const cache = ttlMs > 0 ? `${ttlMs / 1000}s cache` : "no cache";
    console.error(
      `${NAME} ${VERSION} on http://${host}:${bind}/mcp${mode}, ${cache} — ` +
        `default plan: ${client.resolvePlanId()}`,
    );
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      listener.close(() => process.exit(0));
    });
  }
}

// Only when run, never when imported: `createApp` is the seam a test binds a
// port through, and reading the environment on import would kill the test run
// for want of a token.
if (import.meta.main) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(`${NAME}: ${error.message}`);
    } else {
      console.error(`${NAME}: fatal:`, error);
    }
    process.exit(1);
  });
}
