/**
 * The authorization server, requirement by requirement. The numbers are the
 * MUSTs in AGENTS.md, "The remote surface", which are the spec's own; each
 * test here is named for the attack it closes, so a failure says which one
 * has just reopened.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { TOOLS } from "../src/tools/index.ts";
import {
  accessToken,
  authorize,
  browse,
  CLIENT,
  clientPkce,
  consent,
  type Remote,
  remote,
  secretIn,
  stateCookie,
  token,
  USER,
} from "./helpers/remote.ts";

const READ_TOOLS = TOOLS.filter((tool) => tool.annotations.readOnlyHint).length;

/** `tools/list` as an authenticated client. */
async function listTools(served: Remote, access: string): Promise<string[]> {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", served.origin), {
    requestInit: { headers: { authorization: `Bearer ${access}` } },
  });
  await client.connect(transport as unknown as Transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

/** `POST /mcp` with nothing but an `initialize`, and whatever token is given. */
function probe(served: Remote, access?: string): Promise<Response> {
  return fetch(new URL("/mcp", served.origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(access === undefined ? {} : { authorization: `Bearer ${access}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    }),
  });
}

describe("discovery", () => {
  it("answers an unauthenticated call with 401 and a challenge naming both scopes", async () => {
    // The 401 is the whole signal: a client that sees a 200 wrapping an error
    // prints "please sign in" and never starts the flow.
    const served = await remote();
    try {
      const response = await probe(served);
      assert.equal(response.status, 401);
      const challenge = response.headers.get("www-authenticate") ?? "";
      assert.match(challenge, /^Bearer /);
      assert.match(challenge, /error="invalid_token"/);
      assert.ok(
        challenge.includes(
          `resource_metadata="${served.origin}.well-known/oauth-protected-resource/mcp"`,
        ),
        challenge,
      );
      assert.match(challenge, /scope="ynab:read ynab:write"/);
      await response.body?.cancel();
    } finally {
      await served.close();
    }
  });

  it("serves the protected-resource metadata at both well-known paths, naming the exact resource", async () => {
    const served = await remote();
    try {
      for (const path of [
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-protected-resource",
      ]) {
        const response = await fetch(new URL(path, served.origin));
        assert.equal(response.status, 200, path);
        const metadata = (await response.json()) as Record<string, unknown>;
        assert.equal(metadata.resource, served.config.resource);
        assert.deepEqual(metadata.authorization_servers, [served.config.publicUrl.href]);
        assert.deepEqual(metadata.scopes_supported, ["ynab:read", "ynab:write"]);
      }
    } finally {
      await served.close();
    }
  });

  it("advertises S256, a public token endpoint, iss, and no registration endpoint by default", async () => {
    const served = await remote();
    try {
      const response = await fetch(
        new URL("/.well-known/oauth-authorization-server", served.origin),
      );
      const metadata = (await response.json()) as Record<string, unknown>;
      assert.equal(metadata.issuer, served.config.publicUrl.href);
      assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
      assert.ok((metadata.token_endpoint_auth_methods_supported as string[]).includes("none"));
      assert.equal(metadata.authorization_response_iss_parameter_supported, true);
      assert.equal(metadata.registration_endpoint, undefined);
      assert.equal(metadata.revocation_endpoint, `${served.config.publicUrl.href}revoke`);
      // Not a resource requirement, so not advertised: a refresh token is always issued.
      assert.ok(!(metadata.scopes_supported as string[]).includes("offline_access"));
    } finally {
      await served.close();
    }
  });
});

describe("1. per-client consent before the YNAB redirect", () => {
  it("/authorize answers with a page naming the client and its redirect, and YNAB sees nothing", async () => {
    const served = await remote();
    try {
      const response = await authorize(served);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
      const html = await response.text();
      assert.ok(html.includes(CLIENT.client_name ?? ""), "the client's name is not on the page");
      assert.ok(
        html.includes(CLIENT.redirect_uris[0] ?? ""),
        "the redirect URI is not on the page",
      );
      assert.ok(html.includes("change"), "the write scope is not described");
      assert.equal(served.ynab.authorizations.length, 0, "YNAB was contacted before consent");
    } finally {
      await served.close();
    }
  });

  it("consent refused sends the client access_denied with its state and iss, and YNAB still sees nothing", async () => {
    const served = await remote();
    try {
      const page = await authorize(served, { state: "xyz" });
      const denied = await consent(served, secretIn(await page.text()), { decision: "deny" });
      assert.equal(denied.status, 303);
      const location = new URL(denied.headers.get("location") ?? "");
      assert.equal(location.origin + location.pathname, CLIENT.redirect_uris[0]);
      assert.equal(location.searchParams.get("error"), "access_denied");
      assert.equal(location.searchParams.get("state"), "xyz");
      assert.equal(location.searchParams.get("iss"), served.config.publicUrl.href);
      assert.equal(stateCookie(denied), undefined, "a state cookie was set on refusal");
      assert.equal(served.ynab.authorizations.length, 0);
    } finally {
      await served.close();
    }
  });

  it("a consent form posted from another origin is refused", async () => {
    const served = await remote();
    try {
      const page = await authorize(served);
      const secret = secretIn(await page.text());
      const foreign = await consent(served, secret, { origin: "https://attacker.example" });
      assert.equal(foreign.status, 403);
      const none = await consent(served, secret, { origin: null });
      assert.equal(none.status, 403);
      assert.equal(served.ynab.authorizations.length, 0);
    } finally {
      await served.close();
    }
  });

  it("a consent secret is single-use", async () => {
    const served = await remote();
    try {
      const page = await authorize(served);
      const secret = secretIn(await page.text());
      assert.equal((await consent(served, secret)).status, 303);
      assert.equal((await consent(served, secret)).status, 400);
    } finally {
      await served.close();
    }
  });
});

describe("2. the state cookie is set only after consent", () => {
  it("is absent from the consent page and present, __Host- and HttpOnly, on the redirect to YNAB", async () => {
    const served = await remote();
    try {
      const page = await authorize(served);
      assert.equal(page.headers.getSetCookie().length, 0, "a cookie was set before consent");
      const approved = await consent(served, secretIn(await page.text()));
      assert.equal(approved.status, 303);
      const cookie =
        approved.headers.getSetCookie().find((c) => c.startsWith("__Host-ynab_state=")) ?? "";
      assert.match(cookie, /; *HttpOnly/i);
      assert.match(cookie, /; *Secure/i);
      assert.match(cookie, /; *SameSite=Lax/i);
      assert.match(cookie, /; *Path=\//i);
      const toYnab = new URL(approved.headers.get("location") ?? "");
      assert.equal(toYnab.origin, served.ynab.url.origin);
      assert.equal(
        toYnab.searchParams.get("state"),
        stateCookie(approved)?.split("=")[1]?.split(".")[0],
      );
      assert.equal(toYnab.searchParams.get("code_challenge_method"), "S256");
    } finally {
      await served.close();
    }
  });
});

describe("3. exact redirect_uri matching, loopback ports excepted", () => {
  it("a redirect_uri differing by one character is refused before any redirect", async () => {
    const served = await remote();
    try {
      const response = await authorize(served, { redirectUri: `${CLIENT.redirect_uris[0]}x` });
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { error: string }).error, "invalid_request");
    } finally {
      await served.close();
    }
  });

  it("a loopback redirect_uri differing only by port is accepted, as RFC 8252 requires", async () => {
    const native = { ...CLIENT, client_id: "native", redirect_uris: ["http://127.0.0.1/callback"] };
    const served = await remote({ preregistered: [CLIENT, native] });
    try {
      const response = await authorize(served, {
        clientId: "native",
        redirectUri: "http://127.0.0.1:53211/callback",
      });
      assert.equal(response.status, 200);
      assert.ok(
        (await response.text()).includes("local address"),
        "the loopback warning is missing",
      );
      const other = await authorize(served, {
        clientId: "native",
        redirectUri: "http://localhost:53211/callback",
      });
      assert.equal(other.status, 400, "localhost was matched against 127.0.0.1");
    } finally {
      await served.close();
    }
  });
});

describe("4. audience", () => {
  it("a token cannot be minted for another resource", async () => {
    const served = await remote();
    try {
      const page = await authorize(served, { resource: "https://other.example/mcp" });
      assert.equal(page.status, 302);
      const location = new URL(page.headers.get("location") ?? "");
      assert.equal(location.searchParams.get("error"), "invalid_target");

      const authorized = await browse(served);
      const exchanged = await token(served, {
        grant_type: "authorization_code",
        code: authorized.code,
        code_verifier: authorized.verifier,
        resource: "https://other.example/mcp",
      });
      assert.equal(exchanged.status, 400);
      assert.equal(exchanged.body.error, "invalid_target");
    } finally {
      await served.close();
    }
  });

  it("a token issued for another server is rejected on the way in", async () => {
    // `requireBearerAuth` never checks this; the provider does. Forged by
    // writing a row the way another deployment would have.
    const served = await remote();
    try {
      served.store.putTokens({
        accessId: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // sha256("")
        refreshId: "r",
        clientId: CLIENT.client_id,
        userId: "user-1",
        scopes: ["ynab:read"],
        resource: "https://other.example/mcp",
        accessExpiresAt: served.clock.now + 3600,
        refreshExpiresAt: served.clock.now + 3600,
      });
      const response = await probe(served, "");
      assert.equal(response.status, 401);
      await response.body?.cancel();
    } finally {
      await served.close();
    }
  });
});

describe("5. state and codes are single-use and short-lived", () => {
  it("a replayed state fails, and so does a callback without the cookie or with the wrong one", async () => {
    const served = await remote();
    try {
      const page = await authorize(served);
      const approved = await consent(served, secretIn(await page.text()));
      const cookie = stateCookie(approved) ?? "";
      const fromYnab = await fetch(approved.headers.get("location") ?? "", { redirect: "manual" });
      const callback = fromYnab.headers.get("location") ?? "";

      assert.equal((await fetch(callback, { redirect: "manual" })).status, 400, "no cookie");
      assert.equal(
        (await fetch(callback, { redirect: "manual", headers: { cookie: `${cookie}x` } })).status,
        400,
        "tampered cookie",
      );
      assert.equal(
        (await fetch(callback, { redirect: "manual", headers: { cookie } })).status,
        303,
        "the real one",
      );
      assert.equal(
        (await fetch(callback, { redirect: "manual", headers: { cookie } })).status,
        400,
        "replayed",
      );
    } finally {
      await served.close();
    }
  });

  it("a code is spent by its first use, right or wrong", async () => {
    const served = await remote();
    try {
      const authorized = await browse(served);
      const wrong = await token(served, {
        grant_type: "authorization_code",
        code: authorized.code,
        code_verifier: "not-the-verifier",
      });
      assert.equal(wrong.status, 400);
      assert.equal(wrong.body.error, "invalid_grant");
      const right = await token(served, {
        grant_type: "authorization_code",
        code: authorized.code,
        code_verifier: authorized.verifier,
      });
      assert.equal(right.status, 400, "the code survived a failed exchange");
    } finally {
      await served.close();
    }
  });

  it("a code expires after ten minutes", async () => {
    const served = await remote();
    try {
      const authorized = await browse(served);
      served.clock.now += 11 * 60;
      const late = await token(served, {
        grant_type: "authorization_code",
        code: authorized.code,
        code_verifier: authorized.verifier,
      });
      assert.equal(late.body.error, "invalid_grant");
    } finally {
      await served.close();
    }
  });

  it("a code issued to one client cannot be exchanged by another", async () => {
    const other = { ...CLIENT, client_id: "other" };
    const served = await remote({ preregistered: [CLIENT, other] });
    try {
      const authorized = await browse(served);
      const stolen = await token(served, {
        client_id: "other",
        grant_type: "authorization_code",
        code: authorized.code,
        code_verifier: authorized.verifier,
      });
      assert.equal(stolen.body.error, "invalid_grant");
    } finally {
      await served.close();
    }
  });
});

describe("6. refresh tokens rotate", () => {
  it("a refresh returns a new pair, and the old refresh and access tokens both stop working", async () => {
    const served = await remote();
    try {
      const first = await accessToken(served);
      const refreshed = await token(served, {
        grant_type: "refresh_token",
        refresh_token: first.refresh,
      });
      assert.equal(refreshed.status, 200);
      assert.notEqual(refreshed.body.refresh_token, first.refresh);
      assert.notEqual(refreshed.body.access_token, first.access);
      assert.equal(refreshed.body.scope, first.scope);

      const replayed = await token(served, {
        grant_type: "refresh_token",
        refresh_token: first.refresh,
      });
      assert.equal(replayed.status, 400);
      assert.equal(replayed.body.error, "invalid_grant");

      const old = await probe(served, first.access);
      assert.equal(old.status, 401);
      await old.body?.cancel();
      const fresh = await probe(served, refreshed.body.access_token as string);
      assert.equal(fresh.status, 200);
      await fresh.body?.cancel();
    } finally {
      await served.close();
    }
  });

  it("a refresh cannot widen the scopes originally granted", async () => {
    const served = await remote();
    try {
      const readOnly = await accessToken(served, { write: false });
      const widened = await token(served, {
        grant_type: "refresh_token",
        refresh_token: readOnly.refresh,
        scope: "ynab:read ynab:write",
      });
      assert.equal(widened.body.error, "invalid_scope");
    } finally {
      await served.close();
    }
  });

  it("an access token expires after an hour", async () => {
    const served = await remote();
    try {
      const { access } = await accessToken(served);
      served.clock.now += 61 * 60;
      const response = await probe(served, access);
      assert.equal(response.status, 401);
      await response.body?.cancel();
    } finally {
      await served.close();
    }
  });

  it("revocation takes a refresh token and its access token with it", async () => {
    const served = await remote();
    try {
      const { access, refresh } = await accessToken(served);
      const revoked = await fetch(new URL("/revoke", served.origin), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT.client_id, token: refresh }),
      });
      assert.equal(revoked.status, 200);
      const response = await probe(served, access);
      assert.equal(response.status, 401);
      await response.body?.cancel();
    } finally {
      await served.close();
    }
  });
});

describe("7. iss on every authorization response", () => {
  it("the redirect back to the client carries iss equal to the issuer, beside code and state", async () => {
    const served = await remote();
    try {
      const { callback } = await browse(served, { state: "abc" });
      assert.equal(callback.searchParams.get("iss"), served.config.publicUrl.href);
      assert.equal(callback.searchParams.get("state"), "abc");
      assert.ok(callback.searchParams.get("code"));
    } finally {
      await served.close();
    }
  });

  it("YNAB refusing sends the client access_denied with iss", async () => {
    const served = await remote();
    try {
      served.ynab.denyNext();
      const page = await authorize(served);
      const approved = await consent(served, secretIn(await page.text()));
      const fromYnab = await fetch(approved.headers.get("location") ?? "", { redirect: "manual" });
      const back = await fetch(fromYnab.headers.get("location") ?? "", {
        redirect: "manual",
        headers: { cookie: stateCookie(approved) ?? "" },
      });
      assert.equal(back.status, 303);
      const location = new URL(back.headers.get("location") ?? "");
      assert.equal(location.searchParams.get("error"), "access_denied");
      assert.equal(location.searchParams.get("iss"), served.config.publicUrl.href);
    } finally {
      await served.close();
    }
  });
});

describe("scopes decide the tool surface", () => {
  it("ynab:read alone lists exactly the read tools, and asks YNAB for read-only", async () => {
    const served = await remote();
    try {
      const { access, scope } = await accessToken(served, { scope: "ynab:read" });
      assert.equal(scope, "ynab:read");
      assert.equal(served.ynab.authorizations[0]?.get("scope"), "read-only");
      const tools = await listTools(served, access);
      assert.equal(tools.length, READ_TOOLS);
      assert.ok(!tools.includes("create_transaction"));
    } finally {
      await served.close();
    }
  });

  it("write unticked at consent grants ynab:read alone, whatever the client asked for", async () => {
    const served = await remote();
    try {
      const { access, scope } = await accessToken(served, {
        scope: "ynab:read ynab:write",
        write: false,
      });
      assert.equal(scope, "ynab:read");
      assert.equal(served.ynab.authorizations[0]?.get("scope"), "read-only");
      assert.equal((await listTools(served, access)).length, READ_TOOLS);
    } finally {
      await served.close();
    }
  });

  it("both scopes lists everything, and asks YNAB for full access", async () => {
    const served = await remote();
    try {
      const { access, scope } = await accessToken(served);
      assert.equal(scope, "ynab:read ynab:write");
      assert.equal(served.ynab.authorizations[0]?.get("scope"), null);
      assert.equal((await listTools(served, access)).length, TOOLS.length);
    } finally {
      await served.close();
    }
  });

  it("an unknown scope is refused with invalid_scope", async () => {
    const served = await remote();
    try {
      const response = await authorize(served, { scope: "ynab:admin" });
      assert.equal(response.status, 302);
      assert.equal(
        new URL(response.headers.get("location") ?? "").searchParams.get("error"),
        "invalid_scope",
      );
    } finally {
      await served.close();
    }
  });
});

describe("client registration", () => {
  it("/register answers 404 when dynamic registration is off", async () => {
    const served = await remote();
    try {
      const response = await fetch(new URL("/register", served.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://x.example/cb"] }),
      });
      assert.equal(response.status, 404);
      await response.body?.cancel();
    } finally {
      await served.close();
    }
  });

  it("with it on, a client registers as public and completes the flow", async () => {
    const served = await remote({ dynamicRegistration: true });
    try {
      const metadata = (await (
        await fetch(new URL("/.well-known/oauth-authorization-server", served.origin))
      ).json()) as Record<string, unknown>;
      assert.equal(metadata.registration_endpoint, `${served.config.publicUrl.href}register`);
      const registered = await fetch(new URL("/register", served.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Dynamic",
          redirect_uris: ["https://dynamic.example/cb"],
          token_endpoint_auth_method: "none",
        }),
      });
      assert.equal(registered.status, 201);
      const client = (await registered.json()) as { client_id: string };
      const authorized = await browse(served, {
        clientId: client.client_id,
        redirectUri: "https://dynamic.example/cb",
      });
      const exchanged = await token(served, {
        client_id: client.client_id,
        grant_type: "authorization_code",
        code: authorized.code,
        code_verifier: authorized.verifier,
      });
      assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    } finally {
      await served.close();
    }
  });
});

describe("the YNAB grant behind a user", () => {
  it("is refreshed ahead of expiry, once, and the tool call goes through", async () => {
    // Shorter than YNAB's two hours, so our own one-hour token outlives it.
    const served = await remote({ ynabExpiresIn: 1800 });
    try {
      const { access } = await accessToken(served);
      const before = served.ynab.tokenRequests.length;
      served.clock.now += 1800 - 60;
      const client = new Client({ name: "test", version: "0" });
      const transport = new StreamableHTTPClientTransport(new URL("/mcp", served.origin), {
        requestInit: { headers: { authorization: `Bearer ${access}` } },
      });
      await client.connect(transport as unknown as Transport);
      try {
        const results = await Promise.all([
          client.callTool({ name: "get_user" }),
          client.callTool({ name: "get_user" }),
        ]);
        for (const result of results) assert.notEqual(result.isError, true, JSON.stringify(result));
      } finally {
        await client.close();
      }
      const refreshes = served.ynab.tokenRequests
        .slice(before)
        .filter((f) => f.get("grant_type") === "refresh_token");
      assert.equal(refreshes.length, 1, "expected exactly one refresh across concurrent calls");
      assert.equal(refreshes[0]?.get("refresh_token"), "ynab-refresh-2");
    } finally {
      await served.close();
    }
  });

  it("a revoked grant tells the model to reconnect rather than reporting a server bug", async () => {
    const served = await remote({ ynabExpiresIn: 1800 });
    try {
      const { access } = await accessToken(served);
      served.clock.now += 1800;
      // The fake goes away; the next refresh fails.
      await served.ynab.close();
      const client = new Client({ name: "test", version: "0" });
      const transport = new StreamableHTTPClientTransport(new URL("/mcp", served.origin), {
        requestInit: { headers: { authorization: `Bearer ${access}` } },
      });
      await client.connect(transport as unknown as Transport);
      try {
        const result = await client.callTool({ name: "get_user" });
        assert.equal(result.isError, true);
        const text = JSON.stringify(result.content);
        assert.match(text, /disconnect this server/);
        assert.doesNotMatch(text, /bug in the server/);
      } finally {
        await client.close();
      }
    } finally {
      await served.close().catch(() => undefined);
    }
  });

  it("two users are served from two clients", async () => {
    const other = { "user.getUser": { data: { user: { id: "user-2" } } } };
    // One fake API per remote; users are told apart by the id it returns, so
    // give each its own harness and check the grant rows are keyed by it.
    const a = await remote({ replies: USER });
    const b = await remote({ replies: other });
    try {
      await accessToken(a);
      await accessToken(b);
      assert.ok(a.store.getYnabGrant("user-1"));
      assert.equal(a.store.getYnabGrant("user-2"), undefined);
      assert.ok(b.store.getYnabGrant("user-2"));
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("the PKCE the client sends is checked", () => {
  it("a token request with the wrong verifier is invalid_grant", async () => {
    const served = await remote();
    try {
      const other = clientPkce();
      const authorized = await browse(served);
      const exchanged = await token(served, {
        grant_type: "authorization_code",
        code: authorized.code,
        code_verifier: other.verifier,
      });
      assert.equal(exchanged.body.error, "invalid_grant");
    } finally {
      await served.close();
    }
  });
});
