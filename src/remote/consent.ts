/**
 * The browser-facing half of the flow: the consent page `authorize` answers
 * with, the form it posts back, and the route YNAB returns the browser to.
 * Everything here is about cookies and HTML; the decisions are the provider's.
 * See AGENTS.md, "The remote surface".
 */
import express, { type Express } from "express";
import type { RemoteConfig } from "./config.ts";
import { type ConsentView, FlowError, type Provider, type Redirect } from "./provider.ts";
import { CALLBACK_PATH, YnabOAuthError } from "./ynab-oauth.ts";

/** Where the consent form posts. */
export const CONSENT_PATH = "/consent";

/**
 * `__Host-`: the browser refuses it without `Secure` and `Path=/`, and will
 * not let a subdomain overwrite it. The prefix is a guarantee, not a name.
 */
const STATE_COOKIE = "__Host-ynab_state";

/** The state cookie's lifetime, the same ten minutes as the row it matches. */
const STATE_COOKIE_MAX_AGE = 10 * 60;

/** Mount the consent and callback routes on `app`. */
export function registerConsentRoutes(
  app: Express,
  config: RemoteConfig,
  provider: Provider,
): void {
  app.post(CONSENT_PATH, express.urlencoded({ extended: false }), (request, response) => {
    try {
      // CSRF, first line: a cross-site form post carries the other site's
      // Origin. The secret in the form is the second line.
      if (request.get("origin") !== config.publicUrl.origin) {
        throw new FlowError(403, "The consent form was not submitted from this site.");
      }
      const body = request.body as Record<string, unknown>;
      const secret = typeof body.secret === "string" ? body.secret : "";
      const redirect =
        body.decision === "approve"
          ? provider.approve(secret, body.write === "on")
          : provider.deny(secret);
      send(response, redirect);
    } catch (error) {
      fail(response, error);
    }
  });

  app.get(CALLBACK_PATH, (request, response) => {
    void (async () => {
      try {
        const query = request.query as Record<string, unknown>;
        const redirect = await provider.complete(cookie(request.get("cookie"), STATE_COOKIE), {
          ...(typeof query.state === "string" ? { state: query.state } : {}),
          ...(typeof query.code === "string" ? { code: query.code } : {}),
          ...(typeof query.error === "string" ? { error: query.error } : {}),
        });
        send(response, redirect);
      } catch (error) {
        fail(response, error);
      }
    })();
  });
}

function send(response: express.Response, redirect: Redirect): void {
  if (redirect.stateCookie === null) {
    response.clearCookie(STATE_COOKIE, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
  } else if (redirect.stateCookie !== undefined) {
    response.cookie(STATE_COOKIE, redirect.stateCookie, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: STATE_COOKIE_MAX_AGE * 1000,
    });
  }
  response.status(303).set("Cache-Control", "no-store").redirect(303, redirect.location);
}

/** An error page a person can read; the client gets no redirect because there is nothing safe to send it to. */
function fail(response: express.Response, error: unknown): void {
  let status = 500;
  let message = "Something went wrong signing in. Start again from your client.";
  if (error instanceof FlowError) {
    status = error.status;
    message = error.message;
  } else if (error instanceof YnabOAuthError) {
    status = 502;
    message = "YNAB did not accept the sign-in. Start again from your client.";
    console.error("ynab callback:", error.message);
  } else {
    console.error("consent flow:", error);
  }
  response
    .status(status)
    .set("Content-Type", "text/html; charset=utf-8")
    .set("Cache-Control", "no-store")
    .send(page("Sign-in failed", `<p>${html(message)}</p>`));
}

/** One cookie out of the header, without a dependency. */
function cookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

/**
 * The page. It names the client, the exact redirect URI and what is being
 * granted, and lets the user keep writes out — the spec's four requirements
 * for a proxy's consent page, and the one choice this server offers.
 */
export function renderConsent(view: ConsentView): string {
  const host = URL.canParse(view.redirectUri) ? new URL(view.redirectUri).host : view.redirectUri;
  const warning = view.loopback
    ? `<p class="warn">This client can only be reached at a local address on your own computer.
       Any program on that computer could be listening there. Continue only if you started this
       sign-in yourself, just now.</p>`
    : "";
  const write = view.writeRequested
    ? `<label><input type="checkbox" name="write" checked>
         Allow it to <strong>change</strong> your plan — record and edit transactions, assign
         money, create categories and accounts. Untick to allow reading only.</label>`
    : `<p>It asked to <strong>read</strong> your plan only.</p>`;

  return page(
    "Connect to YNAB",
    `<h1>Allow <b>${html(view.clientName)}</b> to use your YNAB plan?</h1>
     <p>You will be sent to YNAB to sign in. Afterwards this client will be able to read your
        plan on your behalf, through this server, until you disconnect it.</p>
     <dl>
       <dt>Client</dt><dd><code>${html(view.clientId)}</code></dd>
       <dt>Will be sent to</dt><dd><code>${html(host)}</code><br><small>${html(view.redirectUri)}</small></dd>
     </dl>
     ${warning}
     <form method="post" action="${CONSENT_PATH}">
       <input type="hidden" name="secret" value="${html(view.secret)}">
       ${write}
       <p>
         <button name="decision" value="approve">Continue to YNAB</button>
         <button name="decision" value="deny" class="quiet">Cancel</button>
       </p>
     </form>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; } code { word-break: break-all; } dt { font-weight: 600; margin-top: .75rem; } dd { margin: 0; }
  label { display: block; margin: 1.25rem 0; } button { font: inherit; padding: .5rem 1rem; }
  .quiet { background: none; border: 1px solid #999; } .warn { background: #fff4e5; padding: .75rem 1rem; border-radius: .25rem; }
</style></head><body>${body}</body></html>`;
}

function html(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
