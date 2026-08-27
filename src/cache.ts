/**
 * An in-memory cache in front of the YNAB SDK, and delta requests where the
 * merge is unambiguous. See AGENTS.md, "Caching against the rate limit".
 */
import type { YnabApi, YnabClient } from "./client.ts";

/** How long a read stays fresh when nothing writes. */
export const DEFAULT_TTL_MS = 60_000;

export interface CacheOptions {
  /** Freshness window in milliseconds. Zero or less disables caching entirely. */
  readonly ttlMs?: number;
  /** Clock seam, so a test does not have to wait a minute. */
  readonly now?: () => number;
}

/**
 * A read whose delta can be merged back into a cached collection without
 * guessing. Exported because `at` is a claim about the SDK's own signatures
 * that a test has to be able to check — see AGENTS.md, "Detecting drift". `knowledgeAt` is where `lastKnowledgeOfServer` sits in the argument
 * list — always last, but the arity differs per endpoint.
 *
 * `categories.getCategories` is deliberately absent: its collection is
 * `category_groups`, each nesting its categories, and YNAB does not document
 * whether a changed group comes back whole or carrying only its changed
 * categories. Replacing a group under the wrong reading silently drops
 * categories, so that endpoint is cached but never refreshed by delta.
 */
export const DELTA: Readonly<Record<string, { at: number; collection: string; key: string }>> = {
  "accounts.getAccounts": { at: 1, collection: "accounts", key: "id" },
  "payees.getPayees": { at: 1, collection: "payees", key: "id" },
  "months.getPlanMonths": { at: 1, collection: "months", key: "month" },
  "scheduledTransactions.getScheduledTransactions": {
    at: 1,
    collection: "scheduled_transactions",
    key: "id",
  },
  "transactions.getTransactions": { at: 4, collection: "transactions", key: "id" },
  "transactions.getTransactionsByAccount": { at: 5, collection: "transactions", key: "id" },
  "transactions.getTransactionsByCategory": { at: 5, collection: "transactions", key: "id" },
  "transactions.getTransactionsByMonth": { at: 5, collection: "transactions", key: "id" },
  "transactions.getTransactionsByPayee": { at: 5, collection: "transactions", key: "id" },
};

/** A response body as the SDK returns it: `{ data: ... }`. */
type Response = { readonly data: Record<string, unknown> };

interface Entry {
  /** The in-flight or settled response. Held as a promise so two identical
   *  reads racing each other make one request, not two. */
  response: Promise<Response>;
  /** When {@link response} stops being served without checking YNAB. */
  expires: number;
  /** `server_knowledge` from the last response, for the next delta request. */
  knowledge?: number | undefined;
}

/**
 * Wrap `client` so repeated reads are answered from memory. Writes clear the
 * plan's entries wholesale — see AGENTS.md on why nothing finer is safe.
 */
export function withCache(client: YnabClient, options: CacheOptions = {}): YnabClient {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  if (ttlMs <= 0) return client;

  const entries = new Map<string, Entry>();

  const api = new Proxy(client.api as object, {
    get(target, group: string, receiver) {
      const namespace = Reflect.get(target, group, receiver);
      if (namespace === null || typeof namespace !== "object") return namespace;

      return new Proxy(namespace, {
        get(inner, method: string, innerReceiver) {
          const original = Reflect.get(inner, method, innerReceiver);
          if (typeof original !== "function") return original;

          const name = `${group}.${method}`;
          const call = (args: unknown[]): Promise<Response> =>
            Reflect.apply(original, namespace, args) as Promise<Response>;

          if (!method.startsWith("get")) {
            return (...args: unknown[]) => {
              // Invalidate before the write, not after: if the write throws
              // partway, whatever it did manage is not left behind a stale read.
              invalidate(entries, args[0]);
              return call(args);
            };
          }

          return (...args: unknown[]) => read(entries, name, args, call, ttlMs, now);
        },
      });
    },
  }) as YnabApi;

  return { api, resolvePlanId: (planId) => client.resolvePlanId(planId) };
}

/** Serve `name(args)` from memory, by delta, or in full — in that order. */
function read(
  entries: Map<string, Entry>,
  name: string,
  args: unknown[],
  call: (args: unknown[]) => Promise<Response>,
  ttlMs: number,
  now: () => number,
): Promise<Response> {
  const key = `${name}(${JSON.stringify(args)})`;
  const cached = entries.get(key);
  if (cached !== undefined && now() < cached.expires) return cached.response;

  const delta = DELTA[name];
  const response =
    cached !== undefined && delta !== undefined && cached.knowledge !== undefined
      ? refresh(cached, delta, args, call, cached.knowledge)
      : call(args);

  const entry: Entry = { response, expires: now() + ttlMs };
  entries.set(key, entry);

  // A failed read must not be served again as if it had succeeded, and must not
  // leave the knowledge value it never received.
  return response.then(
    (settled) => {
      entry.knowledge = knowledgeOf(settled);
      return settled;
    },
    (error: unknown) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    },
  );
}

/** Ask for what changed, and merge it into the collection already held. */
async function refresh(
  cached: Entry,
  delta: { at: number; collection: string; key: string },
  args: unknown[],
  call: (args: unknown[]) => Promise<Response>,
  knowledge: number,
): Promise<Response> {
  const previous = await cached.response;
  const withKnowledge = [...args];
  withKnowledge[delta.at] = knowledge;

  const changes = await call(withKnowledge);
  return {
    data: {
      ...changes.data,
      [delta.collection]: merge(
        rows(previous, delta.collection),
        rows(changes, delta.collection),
        delta.key,
      ),
    },
  };
}

/**
 * `previous` with `changes` applied: a changed row replaces the one it matches,
 * a new row is appended, and a row YNAB marks deleted is dropped. Dropping is
 * what keeps the read surface's promise that it never reports deleted records —
 * a merged view and a full fetch answer identically.
 */
function merge(
  previous: readonly Record<string, unknown>[],
  changes: readonly Record<string, unknown>[],
  key: string,
): Record<string, unknown>[] {
  const byKey = new Map(previous.map((row) => [row[key], row]));
  for (const row of changes) {
    if (row.deleted === true) byKey.delete(row[key]);
    else byKey.set(row[key], row);
  }
  return [...byKey.values()];
}

function rows(response: Response, collection: string): Record<string, unknown>[] {
  const value = response.data[collection];
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function knowledgeOf(response: Response): number | undefined {
  const value = response.data.server_knowledge;
  return typeof value === "number" ? value : undefined;
}

/**
 * Drop every read of the plan a write just touched — or every read, when the
 * write named no plan. Nothing finer is safe: recording one transaction moves
 * a category's balance and activity, the month's totals, the account's three
 * balances, and can create a payee, so a cache that expired only "transactions"
 * would answer the model's next question with figures it had just invalidated.
 */
function invalidate(entries: Map<string, Entry>, planId: unknown): void {
  if (typeof planId !== "string") {
    entries.clear();
    return;
  }
  const scope = JSON.stringify(planId);
  for (const key of entries.keys()) {
    if (key.includes(scope)) entries.delete(key);
  }
}
