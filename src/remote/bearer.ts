/**
 * The gate on `/mcp`. Written here rather than taken from the SDK's
 * `requireBearerAuth` because that middleware's `requiredScopes` does two
 * things at once — names the scopes in the 401 challenge, and demands every
 * one of them on every request — and this server needs the first without the
 * second: a `ynab:read` token is a valid caller. See AGENTS.md, "The remote
 * surface", on why the challenge names both scopes.
 */
import { InvalidTokenError, OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Request, Response } from "express";
import type { RemoteConfig } from "./config.ts";
import { SCOPES } from "./provider.ts";

/**
 * The caller behind a request, or `undefined` after a 401 has been written.
 * A 401 with `WWW-Authenticate` is the whole signal a client needs to start
 * the flow; a 200 carrying an error is what makes it print "please sign in".
 */
export async function authenticate(
  request: Request,
  response: Response,
  verifier: OAuthTokenVerifier,
  config: RemoteConfig,
): Promise<AuthInfo | undefined> {
  try {
    const header = request.get("authorization");
    if (header === undefined) throw new InvalidTokenError("Missing Authorization header");
    const [scheme, token, ...rest] = header.split(" ");
    if (
      scheme?.toLowerCase() !== "bearer" ||
      token === undefined ||
      token === "" ||
      rest.length > 0
    ) {
      throw new InvalidTokenError("Expected `Authorization: Bearer <token>`");
    }
    return await verifier.verifyAccessToken(token);
  } catch (error) {
    const failure = error instanceof OAuthError ? error : new InvalidTokenError("Invalid token");
    const status = failure instanceof InvalidTokenError ? 401 : 400;
    if (status === 401) {
      response.set(
        "WWW-Authenticate",
        `Bearer error="${failure.errorCode}", error_description="${failure.message}", ` +
          `resource_metadata="${getOAuthProtectedResourceMetadataUrl(new URL(config.resource))}", ` +
          `scope="${SCOPES.join(" ")}"`,
      );
    }
    response.status(status).json(failure.toResponseObject());
    return undefined;
  }
}
