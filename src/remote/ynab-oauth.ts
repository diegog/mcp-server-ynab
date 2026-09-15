/**
 * YNAB as the upstream authorization server: where a user is sent to log in,
 * and how the code that comes back is turned into tokens. This is the only
 * module that knows YNAB's OAuth endpoints, and it never sees a client of ours.
 * @see https://api.ynab.com/#oauth-applications
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RemoteConfig } from "./config.ts";
import { randomSecret } from "./seal.ts";

/** The scope YNAB offers. Omitting it grants full access. */
const READ_ONLY_SCOPE = "read-only";

/** Where YNAB sends the browser back, under `PUBLIC_URL`. */
export const CALLBACK_PATH = "/oauth/ynab/callback";

const TokenResponse = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  // YNAB documents one in every response; "should" be there is not "is".
  refresh_token: z.string().optional(),
});

export type YnabTokens = z.infer<typeof TokenResponse>;

/** A PKCE pair for the upstream leg. */
export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

export interface YnabOAuth {
  /** Where to send the browser. `readOnly` asks YNAB for its `read-only` scope. */
  authorizeUrl(params: { state: string; challenge: string; readOnly: boolean }): URL;
  exchangeCode(code: string, verifier: string): Promise<YnabTokens>;
  refresh(refreshToken: string): Promise<YnabTokens>;
}

/** What went wrong at YNAB's token endpoint, with its status for the log. */
export class YnabOAuthError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`YNAB token endpoint answered ${status}: ${body.slice(0, 200)}`);
    this.name = "YnabOAuthError";
    this.status = status;
  }
}

export function createYnabOAuth(
  config: RemoteConfig,
  fetcher: typeof fetch = globalThis.fetch,
): YnabOAuth {
  const redirectUri = `${config.publicUrl.origin}${CALLBACK_PATH}`;
  const tokenEndpoint = new URL("token", config.ynab.oauthUrl);

  const token = async (form: Record<string, string>): Promise<YnabTokens> => {
    const response = await fetcher(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: config.ynab.clientId,
        client_secret: config.ynab.clientSecret,
        ...form,
      }),
    });
    const body = await response.text();
    if (!response.ok) throw new YnabOAuthError(response.status, body);
    return TokenResponse.parse(JSON.parse(body));
  };

  return {
    authorizeUrl({ state, challenge, readOnly }) {
      const url = new URL("authorize", config.ynab.oauthUrl);
      url.searchParams.set("client_id", config.ynab.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      if (readOnly) url.searchParams.set("scope", READ_ONLY_SCOPE);
      return url;
    },
    exchangeCode(code, verifier) {
      return token({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      });
    },
    refresh(refreshToken) {
      return token({ grant_type: "refresh_token", refresh_token: refreshToken });
    },
  };
}

/** A fresh PKCE pair, S256. */
export function pkce(): Pkce {
  const verifier = randomSecret();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
