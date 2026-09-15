#!/usr/bin/env node
/**
 * The same tool surface over Streamable HTTP, for clients that cannot spawn a
 * process — claude.ai on the web and on mobile reach a URL, not a laptop. This
 * file is `index.ts` for the network: it reads the environment, binds a port,
 * and owns everything that only makes sense in a real process.
 *
 * It is also an OAuth authorization server, for the clients, and an OAuth
 * client, to YNAB — see `src/remote/`. No Personal Access Token is read here.
 *
 * See AGENTS.md, "The remote surface".
 */
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Express, Request, Response } from "express";
import type { YnabClient } from "./client.ts";
import { ConfigError } from "./client.ts";
import { CACHE_TTL_ENV, cacheTtlMs, isOn, port, READ_ONLY_ENV } from "./env.ts";
import { authenticate } from "./remote/bearer.ts";
import { MCP_PATH, type RemoteConfig, remoteConfig } from "./remote/config.ts";
import { registerConsentRoutes, renderConsent } from "./remote/consent.ts";
import { createProvider, type Provider, SCOPES, WRITE_SCOPE } from "./remote/provider.ts";
import { createSealer } from "./remote/seal.ts";
import { openStore } from "./remote/store.ts";
import { createUserClients, type UserClients } from "./remote/users.ts";
import { createYnabOAuth } from "./remote/ynab-oauth.ts";
import { connect, createServer, NAME, VERSION } from "./server.ts";

const PORT_ENV = "PORT";
const HOST_ENV = "HOST";

/** The port bound when `PORT` says nothing. 8080, because the process is not root. */
const DEFAULT_PORT = 8080;

/** Loopback unless told otherwise; a container sets `HOST=0.0.0.0` (ENG-58). */
const DEFAULT_HOST = "127.0.0.1";

/** What the app serves. Nothing here is read from the environment. */
export interface AppOptions {
  readonly config: RemoteConfig;
  /** The authorization server, and the verifier every `/mcp` request goes through. */
  readonly provider: Provider;
  /** Where a verified caller's `YnabClient` comes from. */
  readonly users: UserClients;
  /** Serve the read surface alone to everyone, whatever their scopes. See AGENTS.md, "Read-only mode". */
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
  const { config, provider } = options;
  const app = createMcpExpressApp({ host: options.host ?? DEFAULT_HOST });

  // The SDK's router is composed by hand rather than taken as `mcpAuthRouter`,
  // for two things it cannot do: advertise
  // `authorization_response_iss_parameter_supported` (RFC 9207), and serve the
  // protected-resource document at the root well-known path as well as the
  // `/mcp`-suffixed one — Claude tries the second first and falls back to the
  // first, and RFC 9728 has both.
  const oauthMetadata = {
    ...createOAuthMetadata({ provider, issuerUrl: config.publicUrl, scopesSupported: [...SCOPES] }),
    authorization_response_iss_parameter_supported: true,
  };
  const resourceMetadata = {
    resource: config.resource,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: [...SCOPES],
    resource_name: NAME,
    bearer_methods_supported: ["header"],
  };
  app.use("/.well-known/oauth-authorization-server", metadataHandler(oauthMetadata));
  app.use("/.well-known/oauth-protected-resource", metadataHandler(resourceMetadata));
  app.use(`/.well-known/oauth-protected-resource${MCP_PATH}`, metadataHandler(resourceMetadata));
  app.use(
    new URL(oauthMetadata.authorization_endpoint).pathname,
    authorizationHandler({ provider }),
  );
  app.use(new URL(oauthMetadata.token_endpoint).pathname, tokenHandler({ provider }));
  if (oauthMetadata.registration_endpoint !== undefined) {
    app.use(
      new URL(oauthMetadata.registration_endpoint).pathname,
      clientRegistrationHandler({ clientsStore: provider.clientsStore }),
    );
  }
  if (oauthMetadata.revocation_endpoint !== undefined) {
    app.use(new URL(oauthMetadata.revocation_endpoint).pathname, revocationHandler({ provider }));
  }
  registerConsentRoutes(app, config, provider);

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok", name: NAME, version: VERSION });
  });

  app.post(MCP_PATH, (request, response) => {
    void (async () => {
      const auth = await authenticate(request, response, provider, config);
      if (auth === undefined) return;
      const userId = auth.extra?.userId;
      if (typeof userId !== "string") {
        // Cannot happen with our provider; loud rather than serving someone nothing.
        response
          .status(500)
          .json({ error: "server_error", error_description: "token carries no user" });
        return;
      }
      await serve(request, response, {
        client: options.users.clientFor(userId),
        // Read-only is a property of the caller: a scope the user kept off at
        // consent, or a server-wide setting that overrides everyone's.
        readOnly: options.readOnly === true || !auth.scopes.includes(WRITE_SCOPE),
      });
    })();
  });

  // Stateless means there is no standalone stream to open and no session to
  // delete, so both are refused rather than left to answer confusingly.
  app.all(MCP_PATH, (_request, response) => {
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
async function serve(
  request: Request,
  response: Response,
  caller: { readonly client: YnabClient; readonly readOnly: boolean },
): Promise<void> {
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
  const server = createServer(caller.client, { readOnly: caller.readOnly });

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
  // Before the port: a bad setting must kill the process, not leave a server
  // whose every call fails.
  const config = remoteConfig();
  const readOnly = isOn(process.env[READ_ONLY_ENV]);
  const ttlMs = cacheTtlMs(process.env[CACHE_TTL_ENV]);
  const host = process.env[HOST_ENV]?.trim() || DEFAULT_HOST;
  const bind = port(process.env[PORT_ENV], DEFAULT_PORT, PORT_ENV);

  const store = openStore(config.storePath);
  const sealer = createSealer(config.encryptionKey);
  const ynab = createYnabOAuth(config);
  const users = createUserClients({ store, sealer, ynab, cache: { ttlMs } });
  const provider = createProvider({ config, store, sealer, ynab, users, renderConsent });
  const app = createApp({ config, provider, users, readOnly, host });

  const listener = app.listen(bind, host, () => {
    const mode = readOnly ? ", read-only for everyone" : "";
    const cache = ttlMs > 0 ? `${ttlMs / 1000}s cache` : "no cache";
    const registration = config.dynamicRegistration ? "open" : "off";
    console.error(
      `${NAME} ${VERSION} on http://${host}:${bind}${MCP_PATH}${mode}, ${cache} — ` +
        `public URL ${config.publicUrl.href}, ${config.preregistered.length} pre-registered ` +
        `client(s), dynamic registration ${registration}`,
    );
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      listener.close(() => {
        store.close();
        process.exit(0);
      });
    });
  }
}

// Only when run, never when imported: `createApp` is the seam a test binds a
// port through, and reading the environment on import would kill the test run
// for want of a config.
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
