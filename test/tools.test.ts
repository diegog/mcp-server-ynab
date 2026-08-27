/**
 * Handlers through the real server: dispatch, conversion at the boundary, and
 * the shapes that reach the model.
 */
// biome-ignore-all lint/suspicious/noExplicitAny: a tool result is shaped by its
// own output schema, and restating those here would test the test rather than
// the tool. The assertions below name the fields they rely on.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  account,
  category,
  categoryGroup,
  month,
  PLAN_ID,
  transaction,
} from "./helpers/fixtures.ts";
import { harness } from "./helpers/server.ts";

/** The structured payload of a successful call, which the registry validates. */
function dataOf(result: CallToolResult): Record<string, PayloadValue> {
  assert.notEqual(result.isError, true, `unexpected failure: ${JSON.stringify(result)}`);
  assert.ok(result.structuredContent, "no structuredContent");
  return result.structuredContent as Record<string, PayloadValue>;
}

/** A value out of a tool result. Tests narrow it themselves at the assertion. */
type PayloadValue = any;

describe("omitted arguments", () => {
  it("accepts a call with no `arguments` at all", async () => {
    // Legal per the spec, and the SDK at 1.30.0 drops it — see AGENTS.md.
    const test = await harness({ "user.getUser": { data: { user: { id: "user-1" } } } });
    try {
      const raw = await test.client.callTool({ name: "get_user" });
      assert.notEqual(raw.isError, true);
    } finally {
      await test.close();
    }
  });
});

describe("list_transactions dispatch", () => {
  const rows = { data: { transactions: [transaction] } };

  it("uses the unfiltered endpoint when nothing narrows it", async () => {
    const test = await harness({ "transactions.getTransactions": rows });
    try {
      dataOf(await test.call("list_transactions"));
      assert.equal(test.ynab.onlyCall().method, "transactions.getTransactions");
    } finally {
      await test.close();
    }
  });

  it("ranks category above payee above account", async () => {
    const test = await harness({ "transactions.getTransactionsByCategory": rows });
    try {
      dataOf(
        await test.call("list_transactions", {
          category_id: category.id,
          payee_id: "payee-1",
          account_id: account.id,
        }),
      );
      assert.equal(test.ynab.onlyCall().method, "transactions.getTransactionsByCategory");
    } finally {
      await test.close();
    }
  });

  it("turns a losing month into date bounds rather than a row filter", async () => {
    const test = await harness({ "transactions.getTransactionsByAccount": rows });
    try {
      dataOf(await test.call("list_transactions", { account_id: account.id, month: "2026-08-01" }));
      const call = test.ynab.onlyCall();
      assert.equal(call.method, "transactions.getTransactionsByAccount");
      // planId, accountId, sinceDate, untilDate, ...
      assert.equal(call.args[2], "2026-08-01");
      assert.equal(call.args[3], "2026-08-31");
    } finally {
      await test.close();
    }
  });

  it("drops the _currency companion YNAB sends beside every amount", async () => {
    const test = await harness({ "transactions.getTransactions": rows });
    try {
      const data = dataOf(await test.call("list_transactions"));
      const [row] = data.transactions;
      assert.equal(row.amount, -15_500);
      assert.equal(row.amount_formatted, "-$15.50");
      assert.ok(!("amount_currency" in row));
    } finally {
      await test.close();
    }
  });
});

describe("list_categories", () => {
  it("flattens groups but keeps what the group said about itself", async () => {
    const test = await harness({
      "categories.getCategories": { data: { category_groups: [categoryGroup] } },
    });
    try {
      const data = dataOf(await test.call("list_categories"));
      const [row] = data.categories;
      assert.equal(row.name, "Groceries");
      assert.equal(row.group_name, "Immediate Obligations");
      assert.equal(row.group_hidden, false);
    } finally {
      await test.close();
    }
  });

  it("routes a bare month to the plan month, the only per-month source", async () => {
    const test = await harness({ "months.getPlanMonth": { data: { month } } });
    try {
      dataOf(await test.call("list_categories", { month: "2026-08-01" }));
      assert.equal(test.ynab.onlyCall().method, "months.getPlanMonth");
    } finally {
      await test.close();
    }
  });

  it("treats a blank filter as absent rather than as a lookup", async () => {
    const test = await harness({
      "categories.getCategories": { data: { category_groups: [categoryGroup] } },
    });
    try {
      dataOf(await test.call("list_categories", { category_id: "  " }));
      assert.equal(test.ynab.onlyCall().method, "categories.getCategories");
    } finally {
      await test.close();
    }
  });
});

describe("set_category_budget", () => {
  const reply = { "categories.updateMonthCategory": { data: { category } } };

  it("converts the decimal at the boundary and echoes the plan", async () => {
    const test = await harness(reply);
    try {
      const data = dataOf(
        await test.call("set_category_budget", {
          month: "2026-08-01",
          category_id: category.id,
          amount: 123.93,
        }),
      );
      const call = test.ynab.onlyCall();
      assert.deepEqual(call.args[3], { category: { budgeted: 123_930 } });
      assert.equal(data.plan_id, PLAN_ID);
    } finally {
      await test.close();
    }
  });

  it("refuses a mid-month date before spending a request", async () => {
    const test = await harness(reply);
    try {
      const result = await test.call("set_category_budget", {
        month: "2026-08-15",
        category_id: category.id,
        amount: 10,
      });
      assert.equal(result.isError, true);
      assert.equal(test.ynab.calls.length, 0);
    } finally {
      await test.close();
    }
  });
});

describe("create_transaction", () => {
  it("always sends the array form, even for one row", async () => {
    const test = await harness({
      "transactions.createTransaction": {
        data: { transaction_ids: ["transaction-1"], transactions: [transaction] },
      },
    });
    try {
      const data = dataOf(
        await test.call("create_transaction", {
          transactions: [{ account_id: account.id, date: "2026-08-14", amount: -15.5 }],
        }),
      );
      const [, body] = test.ynab.onlyCall().args as [string, { transactions: unknown[] }];
      assert.ok(Array.isArray(body.transactions), "sent the singular form");
      assert.equal(data.transaction_ids.length, 1);
    } finally {
      await test.close();
    }
  });

  it("sends a split as an explicit null category beside its lines", async () => {
    const test = await harness({
      "transactions.createTransaction": { data: { transaction_ids: ["transaction-1"] } },
    });
    try {
      dataOf(
        await test.call("create_transaction", {
          transactions: [
            {
              account_id: account.id,
              date: "2026-08-14",
              amount: -15.5,
              subtransactions: [{ amount: -10 }, { amount: -5.5 }],
            },
          ],
        }),
      );
      const [, body] = test.ynab.onlyCall().args as [string, { transactions: any[] }];
      const [row] = body.transactions;
      assert.equal(row.category_id, null);
      assert.deepEqual(
        row.subtransactions.map((line: { amount: number }) => line.amount),
        [-10_000, -5_500],
      );
    } finally {
      await test.close();
    }
  });

  it("hands a duplicate import_id back as data, not as a failure", async () => {
    const test = await harness({
      "transactions.createTransaction": {
        data: { transaction_ids: [], duplicate_import_ids: ["already-there"] },
      },
    });
    try {
      const data = dataOf(
        await test.call("create_transaction", {
          transactions: [
            {
              account_id: account.id,
              date: "2026-08-14",
              amount: -15.5,
              import_id: "already-there",
            },
          ],
        }),
      );
      assert.deepEqual(data.duplicate_import_ids, ["already-there"]);
    } finally {
      await test.close();
    }
  });

  it("refuses a future date without spending a request", async () => {
    const test = await harness({});
    try {
      const result = await test.call("create_transaction", {
        transactions: [{ account_id: account.id, date: "2099-01-01", amount: -1 }],
      });
      assert.equal(result.isError, true);
      assert.equal(test.ynab.calls.length, 0);
    } finally {
      await test.close();
    }
  });
});

describe("update_transaction", () => {
  it("requires exactly one of id or import_id", async () => {
    const test = await harness({});
    try {
      for (const row of [
        { account_id: account.id, date: "2026-08-14", amount: -1 },
        { id: "t", import_id: "i", account_id: account.id, date: "2026-08-14", amount: -1 },
      ]) {
        const result = await test.call("update_transaction", { transactions: [row] });
        assert.equal(result.isError, true);
      }
      assert.equal(test.ynab.calls.length, 0);
    } finally {
      await test.close();
    }
  });

  it("refuses a split edit rather than letting zod drop the lines in silence", async () => {
    const test = await harness({});
    try {
      const result = await test.call("update_transaction", {
        transactions: [
          {
            id: "transaction-1",
            account_id: account.id,
            date: "2026-08-14",
            amount: -1,
            subtransactions: [{ amount: -1 }],
          },
        ],
      });
      assert.equal(result.isError, true);
      assert.equal(test.ynab.calls.length, 0);
    } finally {
      await test.close();
    }
  });
});
