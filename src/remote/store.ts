/**
 * What the authorization server has to remember between requests, and the
 * `node:sqlite` file it remembers it in. Every id here is already a
 * fingerprint: the store never sees a token or a code in the clear, and a
 * YNAB token arrives already sealed. See AGENTS.md, "The remote surface".
 */
import { DatabaseSync } from "node:sqlite";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/** An authorization a browser has been shown the consent page for. */
export interface PendingAuthorization {
  /** Fingerprint of the secret the consent form carries back. */
  readonly id: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  /** The client's own `state`, echoed back untouched. */
  readonly clientState: string | undefined;
  readonly scopes: readonly string[];
  /** The RFC 8707 resource the client asked for, when it said. */
  readonly resource: string | undefined;
  /** Whether the user kept `ynab:write` on the consent page. */
  readonly write: boolean;
  /** PKCE verifier for the YNAB leg, set with the state at consent. */
  readonly upstreamVerifier: string | undefined;
  /** Seconds since the epoch. */
  readonly expiresAt: number;
}

/** An authorization code we issued, awaiting the token request. */
export interface AuthorizationCode {
  /** Fingerprint of the code. */
  readonly id: string;
  readonly clientId: string;
  readonly userId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly resource: string | undefined;
  readonly expiresAt: number;
}

/** An access token and the refresh token issued beside it. */
export interface IssuedTokens {
  /** Fingerprint of the access token. */
  readonly accessId: string;
  /** Fingerprint of the refresh token. */
  readonly refreshId: string;
  readonly clientId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

/** YNAB's tokens for one user, sealed. */
export interface YnabGrant {
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** When YNAB's access token expires, seconds since the epoch. */
  readonly expiresAt: number;
}

/**
 * The seam. Plain gets and deletes, so a shared implementation needs no
 * transaction; the provider pairs them, and single-use is its job. Anything
 * past its `expiresAt` reads as absent.
 */
export interface TokenStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined;
  putClient(client: OAuthClientInformationFull): void;

  putPending(pending: PendingAuthorization): void;
  /** A pending row that has not yet been consented to. */
  getPending(id: string): PendingAuthorization | undefined;
  /**
   * Record consent: the upstream `state`, the PKCE verifier for the YNAB leg
   * and the scopes kept. From then on the row is reachable only by the state.
   */
  attachState(
    id: string,
    consent: { stateId: string; upstreamVerifier: string; write: boolean },
  ): void;
  getPendingByState(stateId: string): PendingAuthorization | undefined;
  deletePending(id: string): void;

  putCode(code: AuthorizationCode): void;
  getCode(id: string): AuthorizationCode | undefined;
  deleteCode(id: string): void;

  putTokens(tokens: IssuedTokens): void;
  getTokensByAccess(accessId: string): IssuedTokens | undefined;
  getTokensByRefresh(refreshId: string): IssuedTokens | undefined;
  /** Removes the pair, whichever half was looked up. */
  deleteTokens(accessId: string): void;

  putYnabGrant(grant: YnabGrant): void;
  getYnabGrant(userId: string): YnabGrant | undefined;

  close(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    client    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending (
    id             TEXT PRIMARY KEY,
    state_id       TEXT UNIQUE,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    client_state   TEXT,
    scopes         TEXT NOT NULL,
    resource       TEXT,
    write          INTEGER NOT NULL DEFAULT 0,
    upstream_verifier TEXT,
    expires_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codes (
    id             TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes         TEXT NOT NULL,
    resource       TEXT,
    expires_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (
    access_id          TEXT PRIMARY KEY,
    refresh_id         TEXT NOT NULL UNIQUE,
    client_id          TEXT NOT NULL,
    user_id            TEXT NOT NULL,
    scopes             TEXT NOT NULL,
    resource           TEXT NOT NULL,
    access_expires_at  INTEGER NOT NULL,
    refresh_expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ynab_grants (
    user_id       TEXT PRIMARY KEY,
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at    INTEGER NOT NULL
  );
`;

/**
 * Open (creating if needed) the SQLite store at `path`. `":memory:"` is what
 * the tests pass, which is why there is no second implementation.
 */
export function openStore(path: string, now: () => number = nowSeconds): TokenStore {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);

  const statements = {
    getClient: db.prepare("SELECT client FROM clients WHERE client_id = ?"),
    putClient: db.prepare("INSERT OR REPLACE INTO clients (client_id, client) VALUES (?, ?)"),

    putPending: db.prepare(
      `INSERT INTO pending (id, client_id, redirect_uri, code_challenge, client_state, scopes, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getPending: db.prepare(
      "SELECT * FROM pending WHERE id = ? AND state_id IS NULL AND expires_at > ?",
    ),
    getPendingByState: db.prepare("SELECT * FROM pending WHERE state_id = ? AND expires_at > ?"),
    deletePending: db.prepare("DELETE FROM pending WHERE id = ?"),
    attachState: db.prepare(
      "UPDATE pending SET state_id = ?, upstream_verifier = ?, write = ? WHERE id = ? AND state_id IS NULL",
    ),

    putCode: db.prepare(
      `INSERT INTO codes (id, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getCode: db.prepare("SELECT * FROM codes WHERE id = ? AND expires_at > ?"),
    deleteCode: db.prepare("DELETE FROM codes WHERE id = ?"),

    putTokens: db.prepare(
      `INSERT INTO tokens (access_id, refresh_id, client_id, user_id, scopes, resource, access_expires_at, refresh_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getByAccess: db.prepare("SELECT * FROM tokens WHERE access_id = ? AND refresh_expires_at > ?"),
    getByRefresh: db.prepare(
      "SELECT * FROM tokens WHERE refresh_id = ? AND refresh_expires_at > ?",
    ),
    deleteTokens: db.prepare("DELETE FROM tokens WHERE access_id = ?"),

    putGrant: db.prepare(
      `INSERT OR REPLACE INTO ynab_grants (user_id, access_token, refresh_token, expires_at)
       VALUES (?, ?, ?, ?)`,
    ),
    getGrant: db.prepare("SELECT * FROM ynab_grants WHERE user_id = ?"),

    prune: [
      db.prepare("DELETE FROM pending WHERE expires_at <= ?"),
      db.prepare("DELETE FROM codes WHERE expires_at <= ?"),
      db.prepare("DELETE FROM tokens WHERE refresh_expires_at <= ?"),
    ],
  };

  // Expired rows are invisible to every read already; this keeps the file from
  // growing with them, on the writes rather than on a timer.
  const prune = (): void => {
    const at = now();
    for (const statement of statements.prune) statement.run(at);
  };

  return {
    getClient(clientId) {
      const row = statements.getClient.get(clientId) as { client: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.client) as OAuthClientInformationFull);
    },
    putClient(client) {
      statements.putClient.run(client.client_id, JSON.stringify(client));
    },

    putPending(pending) {
      prune();
      statements.putPending.run(
        pending.id,
        pending.clientId,
        pending.redirectUri,
        pending.codeChallenge,
        pending.clientState ?? null,
        JSON.stringify(pending.scopes),
        pending.resource ?? null,
        pending.expiresAt,
      );
    },
    getPending(id) {
      const row = statements.getPending.get(id, now()) as PendingRow | undefined;
      return row === undefined ? undefined : toPending(row);
    },
    attachState(id, consent) {
      statements.attachState.run(
        consent.stateId,
        consent.upstreamVerifier,
        consent.write ? 1 : 0,
        id,
      );
    },
    getPendingByState(stateId) {
      const row = statements.getPendingByState.get(stateId, now()) as PendingRow | undefined;
      return row === undefined ? undefined : toPending(row);
    },
    deletePending(id) {
      statements.deletePending.run(id);
    },

    putCode(code) {
      prune();
      statements.putCode.run(
        code.id,
        code.clientId,
        code.userId,
        code.redirectUri,
        code.codeChallenge,
        JSON.stringify(code.scopes),
        code.resource ?? null,
        code.expiresAt,
      );
    },
    getCode(id) {
      const row = statements.getCode.get(id, now()) as CodeRow | undefined;
      if (row === undefined) return undefined;
      return {
        id: row.id,
        clientId: row.client_id,
        userId: row.user_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        scopes: JSON.parse(row.scopes) as string[],
        resource: row.resource ?? undefined,
        expiresAt: row.expires_at,
      };
    },
    deleteCode(id) {
      statements.deleteCode.run(id);
    },

    putTokens(tokens) {
      prune();
      statements.putTokens.run(
        tokens.accessId,
        tokens.refreshId,
        tokens.clientId,
        tokens.userId,
        JSON.stringify(tokens.scopes),
        tokens.resource,
        tokens.accessExpiresAt,
        tokens.refreshExpiresAt,
      );
    },
    getTokensByAccess(accessId) {
      const row = statements.getByAccess.get(accessId, now()) as TokenRow | undefined;
      return row === undefined ? undefined : toTokens(row);
    },
    getTokensByRefresh(refreshId) {
      const row = statements.getByRefresh.get(refreshId, now()) as TokenRow | undefined;
      return row === undefined ? undefined : toTokens(row);
    },
    deleteTokens(accessId) {
      statements.deleteTokens.run(accessId);
    },

    putYnabGrant(grant) {
      statements.putGrant.run(grant.userId, grant.accessToken, grant.refreshToken, grant.expiresAt);
    },
    getYnabGrant(userId) {
      const row = statements.getGrant.get(userId) as GrantRow | undefined;
      return row === undefined
        ? undefined
        : {
            userId: row.user_id,
            accessToken: row.access_token,
            refreshToken: row.refresh_token,
            expiresAt: row.expires_at,
          };
    },

    close() {
      db.close();
    },
  };
}

interface PendingRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  client_state: string | null;
  scopes: string;
  resource: string | null;
  write: number;
  upstream_verifier: string | null;
  expires_at: number;
}

interface CodeRow {
  id: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string | null;
  expires_at: number;
}

interface TokenRow {
  access_id: string;
  refresh_id: string;
  client_id: string;
  user_id: string;
  scopes: string;
  resource: string;
  access_expires_at: number;
  refresh_expires_at: number;
}

interface GrantRow {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function toPending(row: PendingRow): PendingAuthorization {
  return {
    id: row.id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    clientState: row.client_state ?? undefined,
    scopes: JSON.parse(row.scopes) as string[],
    resource: row.resource ?? undefined,
    write: row.write === 1,
    upstreamVerifier: row.upstream_verifier ?? undefined,
    expiresAt: row.expires_at,
  };
}

function toTokens(row: TokenRow): IssuedTokens {
  return {
    accessId: row.access_id,
    refreshId: row.refresh_id,
    clientId: row.client_id,
    userId: row.user_id,
    scopes: JSON.parse(row.scopes) as string[],
    resource: row.resource,
    accessExpiresAt: row.access_expires_at,
    refreshExpiresAt: row.refresh_expires_at,
  };
}

/** Seconds since the epoch, which is how OAuth counts. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
