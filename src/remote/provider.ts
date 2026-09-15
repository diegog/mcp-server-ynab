/**
 * The authorization server: what the SDK's `OAuthServerProvider` asks for, plus
 * the three steps the SDK does not model — consent given, consent refused, and
 * YNAB's callback. Every secret is hashed before it reaches the store; the
 * only clear-text tokens here are the ones on their way to the client.
 *
 * The confused-deputy mitigations the spec makes MUSTs of are numbered in
 * AGENTS.md, "The remote surface", and the comments below cite them.
 */
import { createHash } from "node:crypto";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import type { RemoteConfig } from "./config.ts";
import { fingerprint, randomSecret, type Sealer } from "./seal.ts";
import { nowSeconds, type PendingAuthorization, type TokenStore } from "./store.ts";
import type { UserClients } from "./users.ts";
import { pkce, type YnabOAuth } from "./ynab-oauth.ts";

/** The two scopes. `ynab:read` alone is served the read surface and asks YNAB for `read-only`. */
export const READ_SCOPE = "ynab:read";
export const WRITE_SCOPE = "ynab:write";
export const SCOPES: readonly string[] = [READ_SCOPE, WRITE_SCOPE];

/** How long each thing we issue lives, in seconds. */
export const ACCESS_TOKEN_TTL = 60 * 60;
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;
/** The spec's own example for `state`; codes get the same. */
export const CODE_TTL = 10 * 60;

/** What the consent page has to show. */
export interface ConsentView {
  /** The client's own name, if it gave one, else its id. */
  readonly clientName: string;
  readonly clientId: string;
  /** Exact registered URI the code will be sent to. */
  readonly redirectUri: string;
  /** Whether the only way to reach this client is a loopback address. */
  readonly loopback: boolean;
  /** Whether `ynab:write` was requested, and so whether the page offers to drop it. */
  readonly writeRequested: boolean;
  /** The single-use secret the form carries back. */
  readonly secret: string;
}

/** Where a step sends the browser next, and the cookie to set with it. */
export interface Redirect {
  readonly location: string;
  /** The signed `state`, to be set as a cookie; `null` clears it. */
  readonly stateCookie?: string | null;
}

export interface Provider extends OAuthServerProvider {
  /** Consent given: bind the state, and send the browser to YNAB. */
  approve(secret: string, write: boolean): Redirect;
  /** Consent refused: send the browser back to the client with `access_denied`. */
  deny(secret: string): Redirect;
  /** YNAB sent the browser back. `cookie` is the raw `__Host-` cookie value, if any. */
  complete(
    cookie: string | undefined,
    query: { state?: string; code?: string; error?: string },
  ): Promise<Redirect>;
}

/** Something wrong with a consent or callback request, for a plain error page. */
export class FlowError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FlowError";
    this.status = status;
  }
}

export interface ProviderOptions {
  readonly config: RemoteConfig;
  readonly store: TokenStore;
  readonly sealer: Sealer;
  readonly ynab: YnabOAuth;
  readonly users: UserClients;
  /** Render the consent page for `authorize` to answer with. */
  readonly renderConsent: (view: ConsentView) => string;
  readonly now?: () => number;
}

export function createProvider(options: ProviderOptions): Provider {
  const { config, store, sealer, ynab, users, renderConsent } = options;
  const now = options.now ?? nowSeconds;
  const preregistered = new Map(config.preregistered.map((client) => [client.client_id, client]));

  const clientsStore = {
    getClient(clientId: string) {
      return preregistered.get(clientId) ?? store.getClient(clientId);
    },
    // Present only when registration is on: the SDK serves `/register` and
    // advertises `registration_endpoint` by whether this method exists.
    ...(config.dynamicRegistration
      ? {
          registerClient(client: OAuthClientInformationFull) {
            store.putClient(client);
            return client;
          },
        }
      : {}),
  };

  const issue = (
    client: OAuthClientInformationFull,
    userId: string,
    scopes: readonly string[],
  ): OAuthTokens => {
    const access = randomSecret();
    const refresh = randomSecret();
    const at = now();
    store.putTokens({
      accessId: fingerprint(access),
      refreshId: fingerprint(refresh),
      clientId: client.client_id,
      userId,
      scopes,
      resource: config.resource,
      accessExpiresAt: at + ACCESS_TOKEN_TTL,
      refreshExpiresAt: at + REFRESH_TOKEN_TTL,
    });
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  };

  /** Requirement 4: a token is only ever minted for, and accepted at, this server. */
  const checkResource = (resource: URL | undefined): void => {
    if (resource !== undefined && resource.href !== config.resource) {
      throw new InvalidTargetError(
        `This server issues tokens for ${config.resource}, not ${resource.href}`,
      );
    }
  };

  /** The authorization response, with `iss` (requirement 7) and the client's `state`. */
  const toClient = (pending: PendingAuthorization, params: Record<string, string>): string => {
    const url = new URL(pending.redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (pending.clientState !== undefined) url.searchParams.set("state", pending.clientState);
    url.searchParams.set("iss", config.publicUrl.href);
    return url.href;
  };

  return {
    clientsStore,
    // PKCE is checked inside `exchangeAuthorizationCode` so the lookup, the
    // check and the deletion are one step: a code is spent by its first use,
    // right or wrong. The SDK hands over `code_verifier` when this is set.
    skipLocalPkceValidation: true,

    async authorize(client, params: AuthorizationParams, res: Response): Promise<void> {
      const scopes =
        params.scopes === undefined || params.scopes.length === 0 ? SCOPES : params.scopes;
      const unknown = scopes.find((scope) => !SCOPES.includes(scope));
      if (unknown !== undefined) {
        throw new InvalidScopeError(
          `Unknown scope ${unknown}; this server offers ${SCOPES.join(" ")}`,
        );
      }
      checkResource(params.resource);

      // Requirement 1: nothing goes to YNAB until this page has been answered.
      const secret = randomSecret();
      store.putPending({
        id: fingerprint(secret),
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        clientState: params.state,
        scopes,
        resource: params.resource?.href,
        write: false,
        upstreamVerifier: undefined,
        expiresAt: now() + CODE_TTL,
      });

      res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Cache-Control", "no-store")
        // Clickjacking a consent page is the attack the page exists to prevent.
        .set("X-Frame-Options", "DENY")
        .set(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        )
        .send(
          renderConsent({
            clientName: client.client_name ?? client.client_id,
            clientId: client.client_id,
            redirectUri: params.redirectUri,
            loopback: client.redirect_uris.every(isLoopback),
            writeRequested: scopes.includes(WRITE_SCOPE),
            secret,
          }),
        );
    },

    approve(secret, write) {
      const pending = store.getPending(fingerprint(secret));
      if (pending === undefined) {
        throw new FlowError(
          400,
          "This authorization request has expired or was already answered. Start again from your client.",
        );
      }
      const keepWrite = write && pending.scopes.includes(WRITE_SCOPE);
      // Requirement 2: the state exists only once consent is given, and the
      // cookie carrying it is set on the same response as the YNAB redirect.
      const state = randomSecret();
      const upstream = pkce();
      store.attachState(pending.id, {
        stateId: fingerprint(state),
        upstreamVerifier: upstream.verifier,
        write: keepWrite,
      });
      return {
        location: ynab.authorizeUrl({ state, challenge: upstream.challenge, readOnly: !keepWrite })
          .href,
        stateCookie: sealer.sign(state),
      };
    },

    deny(secret) {
      const pending = store.getPending(fingerprint(secret));
      if (pending === undefined) {
        throw new FlowError(400, "This authorization request has expired or was already answered.");
      }
      store.deletePending(pending.id);
      const error = new AccessDeniedError("The user declined to authorize this client");
      // No cookie to clear: none is set until consent is given.
      return {
        location: toClient(pending, { error: error.errorCode, error_description: error.message }),
      };
    },

    async complete(cookie, query) {
      // Requirement 5: the state in the cookie, the state in the query and the
      // state on the row must be one value, and the row is deleted on the way past.
      const state = cookie === undefined ? undefined : sealer.verify(cookie);
      if (state === undefined || query.state === undefined || query.state !== state) {
        throw new FlowError(
          400,
          "The sign-in did not start from this browser, or took too long. Start again from your client.",
        );
      }
      const pending = store.getPendingByState(fingerprint(state));
      if (pending === undefined || pending.upstreamVerifier === undefined) {
        throw new FlowError(
          400,
          "This sign-in has already been completed or has expired. Start again from your client.",
        );
      }
      store.deletePending(pending.id);

      if (query.error !== undefined || query.code === undefined) {
        const error = new AccessDeniedError("YNAB did not authorize this server");
        return {
          location: toClient(pending, { error: error.errorCode, error_description: error.message }),
          stateCookie: null,
        };
      }

      const tokens = await ynab.exchangeCode(query.code, pending.upstreamVerifier);
      const userId = await users.identify(tokens.access_token);
      users.remember(userId, tokens);

      const code = randomSecret();
      store.putCode({
        id: fingerprint(code),
        clientId: pending.clientId,
        userId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scopes: pending.write
          ? pending.scopes
          : pending.scopes.filter((scope) => scope !== WRITE_SCOPE),
        resource: pending.resource,
        expiresAt: now() + CODE_TTL,
      });
      return { location: toClient(pending, { code }), stateCookie: null };
    },

    async challengeForAuthorizationCode(): Promise<string> {
      // Unreachable while `skipLocalPkceValidation` is true; the SDK reads the
      // flag before calling this. Loud rather than silent if that ever changes.
      throw new ServerError("PKCE is verified inside exchangeAuthorizationCode");
    },

    async exchangeAuthorizationCode(
      client,
      code,
      verifier,
      redirectUri,
      resource,
    ): Promise<OAuthTokens> {
      const id = fingerprint(code);
      const row = store.getCode(id);
      if (row !== undefined) store.deleteCode(id);
      if (
        row === undefined ||
        row.clientId !== client.client_id ||
        verifier === undefined ||
        challengeOf(verifier) !== row.codeChallenge ||
        (redirectUri !== undefined && redirectUri !== row.redirectUri)
      ) {
        throw new InvalidGrantError(
          "The authorization code is invalid, expired, or was not issued to this client",
        );
      }
      checkResource(resource);
      return issue(client, row.userId, row.scopes);
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource): Promise<OAuthTokens> {
      const row = store.getTokensByRefresh(fingerprint(refreshToken));
      if (row === undefined || row.clientId !== client.client_id) {
        // `invalid_grant` is the code Claude keys a re-authorization on.
        throw new InvalidGrantError(
          "The refresh token is invalid, expired, or was not issued to this client",
        );
      }
      // Requirement 6: rotation. The old pair is gone before the new one exists.
      store.deleteTokens(row.accessId);
      checkResource(resource);
      const granted = scopes === undefined || scopes.length === 0 ? row.scopes : scopes;
      if (granted.some((scope) => !row.scopes.includes(scope))) {
        throw new InvalidScopeError("A refresh cannot widen the scopes originally granted");
      }
      return issue(client, row.userId, granted);
    },

    async verifyAccessToken(token): Promise<AuthInfo> {
      const row = store.getTokensByAccess(fingerprint(token));
      if (row === undefined || row.accessExpiresAt <= now()) {
        throw new InvalidTokenError("The access token is invalid or has expired");
      }
      // Requirement 4, on the way in: `requireBearerAuth` never checks this.
      if (row.resource !== config.resource) {
        throw new InvalidTokenError("The access token was not issued for this server");
      }
      return {
        token,
        clientId: row.clientId,
        scopes: [...row.scopes],
        expiresAt: row.accessExpiresAt,
        resource: new URL(row.resource),
        extra: { userId: row.userId },
      };
    },

    async revokeToken(client, request: OAuthTokenRevocationRequest): Promise<void> {
      const id = fingerprint(request.token);
      const row = store.getTokensByRefresh(id) ?? store.getTokensByAccess(id);
      // Another client's token, or none: per RFC 7009 that is a success with nothing done.
      if (row !== undefined && row.clientId === client.client_id) store.deleteTokens(row.accessId);
    },
  };
}

/** S256, as the client computed it. */
function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function isLoopback(uri: string): boolean {
  if (!URL.canParse(uri)) return false;
  const { hostname } = new URL(uri);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
