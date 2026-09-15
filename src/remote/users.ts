/**
 * One `YnabClient` per user, cached, whose token refreshes under it. Per-user
 * isolation is correctness rather than performance: the read cache in front of
 * each client holds one person's plan, and YNAB's 200 requests an hour are per
 * token, so per user too. See AGENTS.md, "The remote surface".
 */
import { type CacheOptions, withCache } from "../cache.ts";
import { clientForToken, type YnabClient } from "../client.ts";
import { ToolError } from "../errors.ts";
import type { Sealer } from "./seal.ts";
import { nowSeconds, type TokenStore } from "./store.ts";
import type { YnabOAuth, YnabTokens } from "./ynab-oauth.ts";

/** Refresh this far ahead of expiry, so a request never races the clock. */
const REFRESH_AHEAD_SECONDS = 5 * 60;

export interface UserClients {
  /** The client for `userId`, built on first use. */
  clientFor(userId: string): YnabClient;
  /** Seal and store a grant YNAB just issued. */
  remember(userId: string, tokens: YnabTokens): void;
  /** Whose token this is, asked of YNAB. The one request the callback has to make. */
  identify(accessToken: string): Promise<string>;
}

export interface UserClientOptions {
  readonly store: TokenStore;
  readonly sealer: Sealer;
  readonly ynab: YnabOAuth;
  readonly cache?: CacheOptions;
  /** Seam for the tests, which substitute `fakeClient`. */
  readonly makeClient?: (getToken: () => Promise<string>) => YnabClient;
  readonly now?: () => number;
}

export function createUserClients(options: UserClientOptions): UserClients {
  const { store, sealer, ynab } = options;
  const now = options.now ?? nowSeconds;
  const makeClient = options.makeClient ?? ((getToken) => clientForToken(getToken));
  const clients = new Map<string, YnabClient>();
  // Single-flight per user: concurrent tool calls share one refresh rather
  // than racing YNAB with the same refresh token.
  const refreshing = new Map<string, Promise<string>>();

  const remember = (userId: string, tokens: YnabTokens, previousRefresh?: string): void => {
    const refresh = tokens.refresh_token ?? previousRefresh;
    if (refresh === undefined) throw new Error("YNAB issued no refresh token");
    store.putYnabGrant({
      userId,
      accessToken: sealer.seal(tokens.access_token),
      refreshToken: sealer.seal(refresh),
      expiresAt: now() + tokens.expires_in,
    });
  };

  const refresh = (userId: string, sealedRefresh: string): Promise<string> => {
    const inFlight = refreshing.get(userId);
    if (inFlight !== undefined) return inFlight;
    const task = (async () => {
      const previous = sealer.open(sealedRefresh);
      let tokens: YnabTokens;
      try {
        tokens = await ynab.refresh(previous);
      } catch (error) {
        throw disconnected(error);
      }
      remember(userId, tokens, previous);
      return tokens.access_token;
    })().finally(() => refreshing.delete(userId));
    refreshing.set(userId, task);
    return task;
  };

  const getToken = async (userId: string): Promise<string> => {
    const grant = store.getYnabGrant(userId);
    if (grant === undefined) throw disconnected();
    if (grant.expiresAt - now() > REFRESH_AHEAD_SECONDS) return sealer.open(grant.accessToken);
    return refresh(userId, grant.refreshToken);
  };

  return {
    clientFor(userId) {
      let client = clients.get(userId);
      if (client === undefined) {
        client = withCache(
          makeClient(() => getToken(userId)),
          options.cache ?? {},
        );
        clients.set(userId, client);
      }
      return client;
    },
    remember,
    async identify(accessToken) {
      const { data } = await makeClient(async () => accessToken).api.user.getUser();
      return data.user.id;
    },
  };
}

/** The one failure here the model can act on: the user has to reconnect. */
function disconnected(cause?: unknown): ToolError {
  const detail = cause instanceof Error ? ` (${cause.message})` : "";
  return new ToolError(
    "the YNAB authorisation behind this connection has expired or been revoked, so no tool " +
      "can reach the plan. No argument and no retry will fix it: the user has to disconnect " +
      `this server in their client and connect it again to sign in to YNAB afresh.${detail}`,
  );
}
