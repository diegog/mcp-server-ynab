/**
 * The cache is what turns 200 requests an hour into a workable budget, and the
 * thing it must never do is answer with figures a write has already changed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withCache } from "../src/cache.ts";
import { fakeClient, ynabError } from "./helpers/fake-client.ts";
import { account, PLAN_ID } from "./helpers/fixtures.ts";

/** A clock a test can move without waiting. */
function clock(start = 1_000): { now: () => number; advance(ms: number): void } {
  let time = start;
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
  };
}

const accounts = (rows: unknown[], knowledge = 1) => ({
  data: { accounts: rows, server_knowledge: knowledge },
});

describe("serving from memory", () => {
  it("answers a repeated identical read without a second request", async () => {
    const ynab = fakeClient({ "accounts.getAccounts": accounts([account]) });
    const cached = withCache(ynab, { ttlMs: 60_000, now: clock().now });

    await cached.api.accounts.getAccounts(PLAN_ID);
    await cached.api.accounts.getAccounts(PLAN_ID);
    await cached.api.accounts.getAccounts(PLAN_ID);

    assert.equal(ynab.calls.length, 1);
  });

  it("keeps different arguments apart", async () => {
    const ynab = fakeClient({
      "accounts.getAccounts": accounts([account]),
      "accounts.getAccountById": { data: { account } },
    });
    const cached = withCache(ynab, { ttlMs: 60_000, now: clock().now });

    await cached.api.accounts.getAccounts(PLAN_ID);
    await cached.api.accounts.getAccounts("plan-2");
    await cached.api.accounts.getAccountById(PLAN_ID, account.id);

    assert.equal(ynab.calls.length, 3);
  });

  it("makes one request when two identical reads race", async () => {
    const ynab = fakeClient({ "accounts.getAccounts": accounts([account]) });
    const cached = withCache(ynab, { ttlMs: 60_000, now: clock().now });

    await Promise.all([
      cached.api.accounts.getAccounts(PLAN_ID),
      cached.api.accounts.getAccounts(PLAN_ID),
    ]);

    assert.equal(ynab.calls.length, 1);
  });

  it("asks again once the entry has gone stale", async () => {
    const time = clock();
    const ynab = fakeClient({ "accounts.getAccounts": accounts([account]) });
    const cached = withCache(ynab, { ttlMs: 60_000, now: time.now });

    await cached.api.accounts.getAccounts(PLAN_ID);
    time.advance(60_001);
    await cached.api.accounts.getAccounts(PLAN_ID);

    assert.equal(ynab.calls.length, 2);
  });

  it("caches nothing when the window is zero", async () => {
    const ynab = fakeClient({ "accounts.getAccounts": accounts([account]) });
    const cached = withCache(ynab, { ttlMs: 0 });

    await cached.api.accounts.getAccounts(PLAN_ID);
    await cached.api.accounts.getAccounts(PLAN_ID);

    assert.equal(ynab.calls.length, 2);
  });

  it("never caches a failure", async () => {
    const ynab = fakeClient({ "accounts.getAccounts": ynabError("429", "rate_limited", "…") });
    const cached = withCache(ynab, { ttlMs: 60_000, now: clock().now });

    await assert.rejects(() => cached.api.accounts.getAccounts(PLAN_ID));
    await assert.rejects(() => cached.api.accounts.getAccounts(PLAN_ID));

    assert.equal(ynab.calls.length, 2, "a failed read was served from memory");
  });
});

describe("a write invalidates what it could have changed", () => {
  it("drops the plan's reads, not just the collection it wrote to", async () => {
    // Recording a transaction moves a category balance, the month's totals and
    // the account's balances, so nothing finer than the plan is safe.
    const ynab = fakeClient({
      "accounts.getAccounts": accounts([account]),
      "categories.getCategories": { data: { category_groups: [] } },
      "transactions.createTransaction": { data: { transaction_ids: ["t"] } },
    });
    const cached = withCache(ynab, { ttlMs: 60_000, now: clock().now });

    await cached.api.accounts.getAccounts(PLAN_ID);
    await cached.api.categories.getCategories(PLAN_ID);
    assert.equal(ynab.calls.length, 2);

    await cached.api.transactions.createTransaction(PLAN_ID, { transactions: [] });

    await cached.api.accounts.getAccounts(PLAN_ID);
    await cached.api.categories.getCategories(PLAN_ID);
    assert.equal(ynab.calls.length, 5, "a read after a write came from memory");
  });

  it("leaves another plan's reads alone", async () => {
    const ynab = fakeClient({
      "accounts.getAccounts": accounts([account]),
      "transactions.createTransaction": { data: { transaction_ids: ["t"] } },
    });
    const cached = withCache(ynab, { ttlMs: 60_000, now: clock().now });

    await cached.api.accounts.getAccounts("plan-other");
    await cached.api.transactions.createTransaction(PLAN_ID, { transactions: [] });
    await cached.api.accounts.getAccounts("plan-other");

    assert.equal(ynab.calls.length, 2);
  });

  it("clears everything when the write named no plan it could scope to", async () => {
    const ynab = fakeClient({
      "accounts.getAccounts": accounts([account]),
      "transactions.createTransaction": { data: { transaction_ids: ["t"] } },
    });
    const cached = withCache(ynab, { ttlMs: 60_000, now: clock().now });

    await cached.api.accounts.getAccounts(PLAN_ID);
    // Defensive: every write endpoint is plan-scoped today, so this is the
    // branch that keeps a future one from leaving stale reads behind.
    await cached.api.transactions.createTransaction(undefined as never, { transactions: [] });
    await cached.api.accounts.getAccounts(PLAN_ID);

    assert.equal(ynab.calls.length, 3);
  });
});

describe("delta refresh", () => {
  const first = accounts([account], 10);

  it("sends the knowledge it was given last time", async () => {
    const time = clock();
    const ynab = fakeClient({ "accounts.getAccounts": first });
    const cached = withCache(ynab, { ttlMs: 60_000, now: time.now });

    await cached.api.accounts.getAccounts(PLAN_ID);
    time.advance(60_001);
    await cached.api.accounts.getAccounts(PLAN_ID);

    const [, refresh] = ynab.calls;
    assert.deepEqual(refresh?.args, [PLAN_ID, 10]);
  });

  it("merges a changed row over the one it replaces", async () => {
    const time = clock();
    const renamed = { ...account, name: "Chase Everyday" };
    let reply = first;
    const ynab = fakeClient({
      get "accounts.getAccounts"() {
        return reply;
      },
    } as never);
    const cached = withCache(ynab, { ttlMs: 60_000, now: time.now });

    await cached.api.accounts.getAccounts(PLAN_ID);
    reply = accounts([renamed], 11);
    time.advance(60_001);
    const merged = (await cached.api.accounts.getAccounts(PLAN_ID)) as {
      data: { accounts: { id: string; name: string }[] };
    };

    assert.equal(merged.data.accounts.length, 1);
    assert.equal(merged.data.accounts[0]?.name, "Chase Everyday");
  });

  it("keeps rows the delta did not mention", async () => {
    const time = clock();
    const second = { ...account, id: "account-2", name: "Savings" };
    let reply = accounts([account, second], 10);
    const ynab = fakeClient({
      get "accounts.getAccounts"() {
        return reply;
      },
    } as never);
    const cached = withCache(ynab, { ttlMs: 60_000, now: time.now });

    await cached.api.accounts.getAccounts(PLAN_ID);
    reply = accounts([{ ...second, name: "Savings Pot" }], 11);
    time.advance(60_001);
    const merged = (await cached.api.accounts.getAccounts(PLAN_ID)) as {
      data: { accounts: { id: string; name: string }[] };
    };

    assert.deepEqual(
      merged.data.accounts.map((row) => row.name),
      ["Chase Checking", "Savings Pot"],
    );
  });

  it("drops a row the delta reports as deleted, so the view matches a full fetch", async () => {
    const time = clock();
    let reply = accounts([account], 10);
    const ynab = fakeClient({
      get "accounts.getAccounts"() {
        return reply;
      },
    } as never);
    const cached = withCache(ynab, { ttlMs: 60_000, now: time.now });

    await cached.api.accounts.getAccounts(PLAN_ID);
    reply = accounts([{ ...account, deleted: true }], 11);
    time.advance(60_001);
    const merged = (await cached.api.accounts.getAccounts(PLAN_ID)) as {
      data: { accounts: unknown[] };
    };

    // The read surface promises it never reports deleted records, and a merged
    // view has to keep that true.
    assert.deepEqual(merged.data.accounts, []);
  });

  it("refetches categories in full rather than merging a nested delta", async () => {
    const time = clock();
    const ynab = fakeClient({
      "categories.getCategories": { data: { category_groups: [], server_knowledge: 10 } },
    });
    const cached = withCache(ynab, { ttlMs: 60_000, now: time.now });

    await cached.api.categories.getCategories(PLAN_ID);
    time.advance(60_001);
    await cached.api.categories.getCategories(PLAN_ID);

    // No knowledge argument: whether a changed group comes back whole or
    // carrying only its changed categories is undocumented.
    const [, refresh] = ynab.calls;
    assert.deepEqual(refresh?.args, [PLAN_ID]);
  });
});
