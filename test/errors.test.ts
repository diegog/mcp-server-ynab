/**
 * Every failure a tool can hit turns into one sentence the model can act on.
 * See AGENTS.md, "Error mapping".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeFailure, ToolError } from "../src/errors.ts";
import { fakeClient, ynabError } from "./helpers/fake-client.ts";
import { account, PLAN_ID } from "./helpers/fixtures.ts";
import { harness, textOf } from "./helpers/server.ts";

/** The SDK throws the parsed body, not an Error subclass. */
function body(id: string, name = "an_error", detail = "Something was wrong"): unknown {
  return { error: { id, name, detail } };
}

const context = { tool: "list_accounts", args: {}, writes: false };

describe("YNAB failures", () => {
  const mapped: readonly (readonly [string, RegExp])[] = [
    ["400", /malformed|reject/i],
    ["401", /token/i],
    ["403", /refused|restriction/i],
    ["403.1", /subscription/i],
    ["403.2", /trial/i],
    ["403.3", /scope/i],
    ["403.4", /limit/i],
    ["404", /no such record/i],
    ["404.1", /endpoint does not exist/i],
    ["409", /already exists|conflicts/i],
    ["429", /rate limit/i],
    ["500", /unexpected error/i],
    ["503", /unavailable/i],
  ];

  for (const [id, expected] of mapped) {
    it(`explains ${id}`, () => {
      const message = describeFailure(body(id), context);
      assert.match(message, expected);
      assert.ok(message.startsWith("list_accounts: "), "the tool names itself");
      assert.match(message, new RegExp(`YNAB error ${id.replace(".", "\\.")}`));
    });
  }

  it("matches sub-codes before the status they parse to", () => {
    const lapsed = describeFailure(body("403.1"), context);
    const generic = describeFailure(body("403"), context);
    assert.notEqual(lapsed, generic);
  });

  it("tells the model not to retry a 429, and says why", () => {
    const message = describeFailure(body("429"), context);
    assert.match(message, /200 requests per hour/);
    assert.match(message, /rolling/i);
    // A model that reads "rate limited" and nothing else retries immediately.
    assert.match(message, /will fail again|do not retry|wait/i);
  });

  it("echoes the ids it was given, since YNAB never says which was wrong", () => {
    const message = describeFailure(body("404"), {
      tool: "get_transaction",
      args: { plan_id: "plan-9", transaction_id: "txn-9", month: "2026-08-01" },
      writes: false,
    });
    assert.match(message, /plan_id="plan-9"/);
    assert.match(message, /transaction_id="txn-9"/);
    assert.match(message, /month="2026-08-01"/);
  });

  it("leaves a blank id out of that list rather than quoting an empty string", () => {
    const message = describeFailure(body("404"), {
      tool: "get_transaction",
      args: { plan_id: "", transaction_id: "txn-9" },
      writes: false,
    });
    assert.doesNotMatch(message, /plan_id=/);
  });
});

describe("a 400 on a write", () => {
  const detail = "Credit Card Payment categories are not permitted";

  it("leads with YNAB's own detail rather than burying it", () => {
    const message = describeFailure(body("400", "bad_request", detail), {
      tool: "create_transaction",
      args: {},
      writes: true,
    });
    const lead = message.slice(0, message.indexOf(detail) + detail.length);
    assert.ok(message.includes(detail), "detail is missing");
    // Ahead of the generic advice, not in a trailing parenthesis after it.
    assert.ok(lead.length < 140, `detail appears ${lead.length} chars in`);
  });

  it("reads differently from the same status on a read", () => {
    const write = describeFailure(body("400", "bad_request", detail), {
      tool: "create_transaction",
      args: {},
      writes: true,
    });
    const read = describeFailure(body("400", "bad_request", detail), context);
    assert.notEqual(write, read);
    assert.match(write, /nothing was saved/i);
  });
});

describe("failures that are not YNAB's", () => {
  it("passes a ToolError through with only the tool name added", () => {
    const message = describeFailure(
      new ToolError("`amount` is finer than YNAB can store."),
      context,
    );
    assert.equal(message, "list_accounts: `amount` is finer than YNAB can store.");
  });

  it("reads a dead connection as a network failure, not a rejection", () => {
    const message = describeFailure(new TypeError("fetch failed"), context);
    assert.match(message, /could not reach api\.ynab\.com/);
    assert.match(message, /no record was changed/);
  });

  it("reads a non-JSON body as a proxy or maintenance page", () => {
    const message = describeFailure(new SyntaxError("Unexpected token <"), context);
    assert.match(message, /not JSON/);
  });

  it("calls anything left a bug in the server", () => {
    const message = describeFailure(new Error("boom"), context);
    assert.match(message, /bug in the server/);
  });

  it("never leaks a token, because it never receives one", () => {
    const message = describeFailure(body("401"), context);
    assert.doesNotMatch(message, /Bearer|[0-9a-f]{32}/);
  });
});

describe("through a live tool call", () => {
  it("returns a failure as an isError result, not a JSON-RPC error", async () => {
    const test = await harness({
      "accounts.getAccounts": ynabError("429", "too_many_requests", "…"),
    });
    try {
      const result = await test.call("list_accounts");
      assert.equal(result.isError, true);
      assert.match(textOf(result), /rate limit/i);
      // An error result carries no structuredContent: the SDK skips output
      // validation when isError is set.
      assert.equal(result.structuredContent, undefined);
    } finally {
      await test.close();
    }
  });

  it("takes `writes` from the tool's own annotation, not from its name", async () => {
    const test = await harness({
      "accounts.createAccount": ynabError("400", "bad_request", "An account type is required"),
    });
    try {
      const result = await test.call("create_account", {
        name: "Savings",
        type: "savings",
        balance: 10,
      });
      assert.match(textOf(result), /rejected the write/i);
    } finally {
      await test.close();
    }
  });

  it("reaches YNAB with the resolved plan id when none was given", async () => {
    const client = fakeClient({ "accounts.getAccounts": { data: { accounts: [account] } } });
    assert.equal(client.resolvePlanId(), PLAN_ID);
  });
});
