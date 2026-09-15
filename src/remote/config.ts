/**
 * The environment the remote entrypoint reads, validated at startup so a bad
 * value is a `ConfigError` with the variable's name in it rather than a 500 an
 * hour later. Nothing here is read anywhere else; `src/http.ts` builds this
 * once and passes it down. See AGENTS.md, "The remote surface".
 */
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ConfigError } from "../client.ts";
import { isOn } from "../env.ts";
import { KEY_BYTES } from "./seal.ts";

export const PUBLIC_URL_ENV = "PUBLIC_URL";
export const YNAB_CLIENT_ID_ENV = "YNAB_OAUTH_CLIENT_ID";
export const YNAB_CLIENT_SECRET_ENV = "YNAB_OAUTH_CLIENT_SECRET";
export const ENCRYPTION_KEY_ENV = "YNAB_TOKEN_ENCRYPTION_KEY";
export const STORE_PATH_ENV = "YNAB_STORE_PATH";
export const MCP_CLIENT_ID_ENV = "MCP_CLIENT_ID";
export const MCP_CLIENT_REDIRECT_URIS_ENV = "MCP_CLIENT_REDIRECT_URIS";
export const DYNAMIC_REGISTRATION_ENV = "MCP_DYNAMIC_REGISTRATION";

/** Where the store lives when `YNAB_STORE_PATH` says nothing. */
export const DEFAULT_STORE_PATH = "/data/ynab-mcp.sqlite";

/** Where the hosted Claude surfaces receive an authorization code. */
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** YNAB's authorization server, which the tests point elsewhere. */
export const YNAB_OAUTH_URL = new URL("https://app.ynab.com/oauth/");

/** The path the tool surface is served at, under `PUBLIC_URL`. */
export const MCP_PATH = "/mcp";

export interface RemoteConfig {
  /**
   * The one origin every absolute URL derives from. `href` carries the trailing
   * slash `URL` insists on and is the issuer identifier; build paths on `origin`.
   */
  readonly publicUrl: URL;
  /** The RFC 8707 resource identifier: `publicUrl` + `/mcp`, exactly as pasted into a client. */
  readonly resource: string;
  readonly ynab: {
    readonly clientId: string;
    readonly clientSecret: string;
    /** Base of the `authorize` and `token` endpoints, with a trailing slash. */
    readonly oauthUrl: URL;
  };
  /** 32 bytes, for `createSealer`. */
  readonly encryptionKey: Buffer;
  readonly storePath: string;
  /** Clients known in advance. See AGENTS.md on why this is the default path. */
  readonly preregistered: readonly OAuthClientInformationFull[];
  /** Whether `/register` is served at all. */
  readonly dynamicRegistration: boolean;
}

/** Build the config from `env`, throwing {@link ConfigError} on the first bad value. */
export function remoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const publicUrl = parsePublicUrl(required(env, PUBLIC_URL_ENV));
  const clientId = required(env, YNAB_CLIENT_ID_ENV);
  const clientSecret = required(env, YNAB_CLIENT_SECRET_ENV);
  const encryptionKey = parseKey(required(env, ENCRYPTION_KEY_ENV));

  return {
    publicUrl,
    resource: `${publicUrl.origin}${MCP_PATH}`,
    ynab: { clientId, clientSecret, oauthUrl: YNAB_OAUTH_URL },
    encryptionKey,
    storePath: provided(env[STORE_PATH_ENV]) ?? DEFAULT_STORE_PATH,
    preregistered: preregisteredClients(env),
    dynamicRegistration: isOn(env[DYNAMIC_REGISTRATION_ENV]),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = provided(env[name]);
  if (value === undefined) {
    throw new ConfigError(`${name} is not set. The remote entrypoint needs it — see .env.example.`);
  }
  return value;
}

/** Blank counts as absent, as it does in `resolvePlanId`. */
function provided(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * HTTPS, or plain HTTP on a loopback host for local runs; no path, query or
 * fragment, because it is an issuer identifier as well as an origin.
 */
function parsePublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${PUBLIC_URL_ENV} is ${JSON.stringify(value)}, which is not a URL.`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConfigError(
      `${PUBLIC_URL_ENV} must be https:// (or http://localhost for a local run), got ${JSON.stringify(value)}.`,
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError(
      `${PUBLIC_URL_ENV} must not carry a query or fragment: ${JSON.stringify(value)}.`,
    );
  }
  if (url.pathname !== "/") {
    throw new ConfigError(
      `${PUBLIC_URL_ENV} must be an origin with no path — the server serves ${MCP_PATH} under it. ` +
        `Got ${JSON.stringify(value)}.`,
    );
  }
  return url;
}

function parseKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) {
    throw new ConfigError(
      `${ENCRYPTION_KEY_ENV} must be ${KEY_BYTES} random bytes, base64-encoded ` +
        `(\`openssl rand -base64 ${KEY_BYTES}\`); the value given decodes to ${key.length} bytes.`,
    );
  }
  return key;
}

/**
 * One client from the environment, public, with the Claude callback unless the
 * redirect URIs are given. A client id without a redirect list is the common
 * case; a redirect list without a client id is a mistake worth naming.
 */
function preregisteredClients(env: NodeJS.ProcessEnv): OAuthClientInformationFull[] {
  const clientId = provided(env[MCP_CLIENT_ID_ENV]);
  const redirects = provided(env[MCP_CLIENT_REDIRECT_URIS_ENV]);
  if (clientId === undefined) {
    if (redirects !== undefined) {
      throw new ConfigError(
        `${MCP_CLIENT_REDIRECT_URIS_ENV} is set but ${MCP_CLIENT_ID_ENV} is not; the redirect URIs belong to a client.`,
      );
    }
    return [];
  }
  const redirectUris = (redirects ?? CLAUDE_CALLBACK).split(/\s+/);
  for (const uri of redirectUris) {
    if (!URL.canParse(uri)) {
      throw new ConfigError(
        `${MCP_CLIENT_REDIRECT_URIS_ENV} contains ${JSON.stringify(uri)}, which is not a URL.`,
      );
    }
  }
  return [
    {
      client_id: clientId,
      client_name: "Pre-registered client",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  ];
}
