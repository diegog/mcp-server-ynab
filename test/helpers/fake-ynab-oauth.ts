/**
 * YNAB's authorization server, faked on a local port so the whole suite stays
 * offline — the same job `fakeClient` does for the API. It speaks just enough
 * OAuth for our upstream leg: `authorize` bounces the browser straight back
 * with a code, `token` exchanges or refreshes it, and every request is
 * recorded so a test can assert what was — or was not — sent.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeYnabOAuth {
  /** Base of the `authorize` and `token` endpoints, with a trailing slash. */
  readonly url: URL;
  /** Every `GET /authorize` seen, as its query. */
  readonly authorizations: readonly URLSearchParams[];
  /** Every `POST /token` seen, as its form body. */
  readonly tokenRequests: readonly URLSearchParams[];
  /** Have `authorize` send the browser back with `error=access_denied`. */
  denyNext(): void;
  close(): Promise<void>;
}

export interface FakeYnabOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** What `expires_in` says. Two hours is YNAB's. */
  readonly expiresIn?: number;
}

export async function fakeYnabOAuth(options: FakeYnabOptions): Promise<FakeYnabOAuth> {
  const authorizations: URLSearchParams[] = [];
  const tokenRequests: URLSearchParams[] = [];
  // code → the PKCE challenge it was issued against
  const codes = new Map<string, string>();
  const refreshTokens = new Set<string>();
  let deny = false;
  let issued = 0;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");

    if (request.method === "GET" && url.pathname === "/authorize") {
      authorizations.push(url.searchParams);
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      const state = url.searchParams.get("state");
      if (state !== null) back.searchParams.set("state", state);
      if (deny) {
        deny = false;
        back.searchParams.set("error", "access_denied");
      } else {
        const code = `ynab-code-${++issued}`;
        codes.set(code, url.searchParams.get("code_challenge") ?? "");
        back.searchParams.set("code", code);
      }
      response.writeHead(302, { location: back.href }).end();
      return;
    }

    if (request.method === "POST" && url.pathname === "/token") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        tokenRequests.push(form);
        const json = (status: number, payload: unknown): void => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        if (
          form.get("client_id") !== options.clientId ||
          form.get("client_secret") !== options.clientSecret
        ) {
          json(401, { error: "invalid_client" });
          return;
        }
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
          const code = form.get("code") ?? "";
          const challenge = codes.get(code);
          codes.delete(code);
          const verifier = form.get("code_verifier") ?? "";
          const expected = createHash("sha256").update(verifier).digest("base64url");
          if (challenge === undefined || challenge !== expected) {
            json(400, { error: "invalid_grant" });
            return;
          }
        } else if (grant === "refresh_token") {
          const refresh = form.get("refresh_token") ?? "";
          if (!refreshTokens.delete(refresh)) {
            json(400, { error: "invalid_grant" });
            return;
          }
        } else {
          json(400, { error: "unsupported_grant_type" });
          return;
        }
        issued += 1;
        const refresh_token = `ynab-refresh-${issued}`;
        refreshTokens.add(refresh_token);
        json(200, {
          access_token: `ynab-access-${issued}`,
          token_type: "bearer",
          expires_in: options.expiresIn ?? 7200,
          refresh_token,
        });
      });
      return;
    }

    response.writeHead(404).end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    url: new URL(`http://127.0.0.1:${port}/`),
    authorizations,
    tokenRequests,
    denyNext: () => {
      deny = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
