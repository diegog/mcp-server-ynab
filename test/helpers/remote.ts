/**
 * The remote entrypoint, whole, on a real port: the app, an in-memory store,
 * a faked YNAB API behind the per-user clients and a faked YNAB authorization
 * server on a port of its own. `browser` walks the authorization flow the way
 * a user agent would, with redirects followed by hand so each hop can be
 * asserted on.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { YnabClient } from "../../src/client.ts";
import { createApp } from "../../src/http.ts";
import { type RemoteConfig, YNAB_OAUTH_URL } from "../../src/remote/config.ts";
import { renderConsent } from "../../src/remote/consent.ts";
import { createProvider, type Provider } from "../../src/remote/provider.ts";
import { createSealer, randomSecret } from "../../src/remote/seal.ts";
import { openStore, type TokenStore } from "../../src/remote/store.ts";
import { createUserClients } from "../../src/remote/users.ts";
import { createYnabOAuth } from "../../src/remote/ynab-oauth.ts";
import { fakeClient, type Replies } from "./fake-client.ts";
import { type FakeYnabOAuth, fakeYnabOAuth } from "./fake-ynab-oauth.ts";

export const YNAB_CLIENT = { clientId: "ynab-app", clientSecret: "ynab-app-secret" };
export const KEY = Buffer.alloc(32, 7);

/** The client a test authorizes as unless it says otherwise. */
export const CLIENT: OAuthClientInformationFull = {
  client_id: "test-client",
  client_name: "Test Client",
  redirect_uris: ["https://client.example/callback"],
  token_endpoint_auth_method: "none",
};

/** A fake user the callback's `identify` will find. */
export const USER: Replies = { "user.getUser": { data: { user: { id: "user-1" } } } };

export interface RemoteOptions {
  /** Replies for the faked YNAB API every user's client answers from. */
  readonly replies?: Replies;
  readonly readOnly?: boolean;
  readonly dynamicRegistration?: boolean;
  readonly preregistered?: readonly OAuthClientInformationFull[];
  /** YNAB access-token lifetime the fake reports, seconds. */
  readonly ynabExpiresIn?: number;
}

export interface Remote {
  readonly origin: string;
  readonly config: RemoteConfig;
  readonly provider: Provider;
  readonly store: TokenStore;
  readonly ynab: FakeYnabOAuth;
  /** The clock every component reads; advance it to expire things. */
  clock: { now: number };
  close(): Promise<void>;
}

/** Boot everything. `PUBLIC_URL` is the real origin, so discovery URLs resolve. */
export async function remote(options: RemoteOptions = {}): Promise<Remote> {
  const ynab = await fakeYnabOAuth({
    ...YNAB_CLIENT,
    ...(options.ynabExpiresIn === undefined ? {} : { expiresIn: options.ynabExpiresIn }),
  });
  const port = await freePort();
  const publicUrl = new URL(`http://127.0.0.1:${port}`);
  const config: RemoteConfig = {
    publicUrl,
    resource: `${publicUrl.origin}/mcp`,
    ynab: { ...YNAB_CLIENT, oauthUrl: ynab.url },
    encryptionKey: KEY,
    storePath: ":memory:",
    preregistered: options.preregistered ?? [CLIENT],
    dynamicRegistration: options.dynamicRegistration ?? false,
  };
  const clock = { now: 1_800_000_000 };
  const now = () => clock.now;
  const store = openStore(config.storePath, now);
  const sealer = createSealer(config.encryptionKey);
  const upstream = createYnabOAuth(config);
  const replies = options.replies ?? USER;
  const users = createUserClients({
    store,
    sealer,
    ynab: upstream,
    now,
    cache: { ttlMs: 0 },
    makeClient: (getToken) => resolvingToken(fakeClient(replies), getToken),
  });
  const provider = createProvider({
    config,
    store,
    sealer,
    ynab: upstream,
    users,
    renderConsent,
    now,
  });
  const app = createApp({
    config,
    provider,
    users,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  const listener = app.listen(port, "127.0.0.1");
  await once(listener, "listening");

  return {
    origin: publicUrl.href,
    config,
    provider,
    store,
    ynab,
    clock,
    close: async () => {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
      store.close();
      await ynab.close();
    },
  };
}

/**
 * The real SDK awaits the token before every request, which is what lets a
 * refresh happen under a call. `fakeClient` never would, so this puts that
 * one behaviour back in front of it.
 */
function resolvingToken(client: YnabClient, getToken: () => Promise<string>): YnabClient {
  const api = new Proxy(client.api as object, {
    get(target, group: string, receiver) {
      const namespace = Reflect.get(target, group, receiver) as object;
      return new Proxy(namespace, {
        get(inner, method: string, innerReceiver) {
          const original = Reflect.get(inner, method, innerReceiver) as (
            ...args: unknown[]
          ) => unknown;
          return async (...args: unknown[]) => {
            await getToken();
            return original(...args);
          };
        },
      });
    },
  });
  return { api: api as YnabClient["api"], resolvePlanId: client.resolvePlanId };
}

/** A port nothing is listening on right now — bound and released, so the app can announce it before it binds. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** PKCE for the client leg. */
export function clientPkce(): { verifier: string; challenge: string } {
  const verifier = randomSecret();
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface AuthorizeOptions {
  readonly clientId?: string;
  readonly redirectUri?: string;
  /** Space-separated, as on the wire. Omit to send none. */
  readonly scope?: string;
  readonly resource?: string;
  readonly state?: string;
  readonly challenge?: string;
}

/** `GET /authorize` as a client would send it, redirects left unfollowed. */
export function authorize(remote: Remote, options: AuthorizeOptions = {}): Promise<Response> {
  const url = new URL("/authorize", remote.origin);
  url.searchParams.set("client_id", options.clientId ?? CLIENT.client_id);
  url.searchParams.set("redirect_uri", options.redirectUri ?? CLIENT.redirect_uris[0] ?? "");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", options.challenge ?? clientPkce().challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state ?? "client-state");
  url.searchParams.set("resource", options.resource ?? remote.config.resource);
  if (options.scope !== undefined) url.searchParams.set("scope", options.scope);
  return fetch(url, { redirect: "manual" });
}

/** The single-use secret out of a rendered consent page. */
export function secretIn(html: string): string {
  const match = /name="secret" value="([^"]+)"/.exec(html);
  if (match?.[1] === undefined) throw new Error("no consent secret in page");
  return match[1];
}

export interface ConsentOptions {
  readonly decision?: "approve" | "deny";
  readonly write?: boolean;
  /** `Origin` header; `null` sends none. Defaults to the server's own. */
  readonly origin?: string | null;
}

/** `POST /consent`, as the page's form would. */
export function consent(
  remote: Remote,
  secret: string,
  options: ConsentOptions = {},
): Promise<Response> {
  const form = new URLSearchParams({ secret, decision: options.decision ?? "approve" });
  if (options.write ?? true) form.set("write", "on");
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const origin = options.origin === undefined ? new URL(remote.origin).origin : options.origin;
  if (origin !== null) headers.origin = origin;
  return fetch(new URL("/consent", remote.origin), {
    method: "POST",
    headers,
    body: form,
    redirect: "manual",
  });
}

/** The `__Host-` state cookie out of a response, as `name=value`. */
export function stateCookie(response: Response): string | undefined {
  const header = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("__Host-ynab_state="));
  return header?.split(";")[0];
}

export interface Authorized {
  readonly code: string;
  /** The redirect back to the client, in full. */
  readonly callback: URL;
  readonly verifier: string;
}

/**
 * Walk the whole browser side: authorize → consent → YNAB → our callback →
 * the client's redirect, returning the code and what it was bound to.
 */
export async function browse(
  remote: Remote,
  options: AuthorizeOptions & ConsentOptions = {},
): Promise<Authorized> {
  const pkce = clientPkce();
  const page = await authorize(remote, { ...options, challenge: pkce.challenge });
  if (page.status !== 200)
    throw new Error(`authorize answered ${page.status}: ${await page.text()}`);
  const approved = await consent(remote, secretIn(await page.text()), options);
  if (approved.status !== 303)
    throw new Error(`consent answered ${approved.status}: ${await approved.text()}`);
  const cookie = stateCookie(approved);
  const toYnab = approved.headers.get("location") ?? "";
  const fromYnab = await fetch(toYnab, { redirect: "manual" });
  const toCallback = fromYnab.headers.get("location") ?? "";
  const back = await fetch(toCallback, {
    redirect: "manual",
    headers: cookie === undefined ? {} : { cookie },
  });
  if (back.status !== 303)
    throw new Error(`callback answered ${back.status}: ${await back.text()}`);
  const callback = new URL(back.headers.get("location") ?? "");
  const code = callback.searchParams.get("code");
  if (code === null) throw new Error(`no code in ${callback.href}`);
  return { code, callback, verifier: pkce.verifier };
}

export interface TokenResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** `POST /token` for a code, or for a refresh token. */
export async function token(remote: Remote, form: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(new URL("/token", remote.origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT.client_id, ...form }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The whole thing: an access token for `CLIENT`, ready to use. */
export async function accessToken(
  remote: Remote,
  options: AuthorizeOptions & ConsentOptions = {},
): Promise<{ access: string; refresh: string; scope: string }> {
  const authorized = await browse(remote, options);
  const exchanged = await token(remote, {
    grant_type: "authorization_code",
    code: authorized.code,
    code_verifier: authorized.verifier,
    redirect_uri: options.redirectUri ?? CLIENT.redirect_uris[0] ?? "",
    resource: remote.config.resource,
  });
  if (exchanged.status !== 200)
    throw new Error(`token answered ${exchanged.status}: ${JSON.stringify(exchanged.body)}`);
  return {
    access: exchanged.body.access_token as string,
    refresh: exchanged.body.refresh_token as string,
    scope: exchanged.body.scope as string,
  };
}
