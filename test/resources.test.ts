/**
 * The resource layer is a second surface over the M2 handlers, so what it must
 * prove is that it *is* the same surface — not a parallel implementation that
 * can drift.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SCHEME, transactionUri } from "../src/resources.ts";
import { account, categoryGroup, PLAN_ID, transaction } from "./helpers/fixtures.ts";
import { harness } from "./helpers/server.ts";

/** The text of a resource read, narrowed past the text-or-blob union. */
function bodyOf(result: Awaited<ReturnType<Client["readResource"]>>): string {
  const [content] = result.contents;
  assert.ok(content !== undefined && "text" in content, "resource came back without text");
  return content.text;
}

describe("discovery", () => {
  it("declares the resources capability", async () => {
    const test = await harness();
    try {
      assert.ok(test.client.getServerCapabilities()?.resources, "resources capability absent");
    } finally {
      await test.close();
    }
  });

  it("lists the fixed URIs directly and the rest as templates", async () => {
    const test = await harness();
    try {
      const { resources } = await test.client.listResources();
      const { resourceTemplates } = await test.client.listResourceTemplates();

      assert.deepEqual(
        resources.map((entry) => entry.uri),
        ["ynab://user", "ynab://plans"],
      );
      assert.ok(resourceTemplates.length > 15, `only ${resourceTemplates.length} templates`);
      for (const entry of [...resources, ...resourceTemplates]) {
        const uri = "uri" in entry ? entry.uri : entry.uriTemplate;
        assert.ok(uri.startsWith(SCHEME), `${uri} is outside the scheme`);
        assert.equal(entry.mimeType, "application/json");
        assert.ok((entry.description ?? "").length > 0, `${uri} has no description`);
      }
    } finally {
      await test.close();
    }
  });

  it("spends no request on discovery", async () => {
    const test = await harness();
    try {
      await test.client.listResources();
      await test.client.listResourceTemplates();
      // Listing every account of every plan to enumerate a template would cost
      // requests nobody asked for — see AGENTS.md, "The resource layer".
      assert.equal(test.ynab.calls.length, 0);
    } finally {
      await test.close();
    }
  });
});

describe("reading", () => {
  it("answers with exactly what the tool would return", async () => {
    const reply = { "accounts.getAccounts": { data: { accounts: [account] } } };

    const viaTool = await harness(reply);
    const viaResource = await harness(reply);
    try {
      const tool = await viaTool.call("list_accounts");
      const resource = await viaResource.client.readResource({
        uri: `ynab://plans/${PLAN_ID}/accounts`,
      });

      assert.equal(resource.contents[0]?.uri, `ynab://plans/${PLAN_ID}/accounts`);
      // Serialized on both sides: the in-memory transport hands `structuredContent`
      // over by reference, so it keeps `undefined`-valued keys that a real client
      // would never see. Comparing JSON compares what actually goes on the wire.
      assert.equal(
        JSON.stringify(JSON.parse(bodyOf(resource))),
        JSON.stringify(tool.structuredContent),
      );
    } finally {
      await viaTool.close();
      await viaResource.close();
    }
  });

  it("passes template variables through as tool arguments", async () => {
    const test = await harness({ "accounts.getAccountById": { data: { account } } });
    try {
      await test.client.readResource({ uri: `ynab://plans/${PLAN_ID}/accounts/${account.id}` });
      const call = test.ynab.onlyCall();
      assert.equal(call.method, "accounts.getAccountById");
      assert.deepEqual(call.args, [PLAN_ID, account.id]);
    } finally {
      await test.close();
    }
  });

  it("routes a month-and-category URI to the one endpoint that binds both", async () => {
    const test = await harness({
      "categories.getMonthCategoryById": { data: { category: categoryGroup.categories[0] } },
    });
    try {
      await test.client.readResource({
        uri: `ynab://plans/${PLAN_ID}/months/2026-08-01/categories/category-1`,
      });
      assert.equal(test.ynab.onlyCall().method, "categories.getMonthCategoryById");
    } finally {
      await test.close();
    }
  });

  it("still serves resources in read-only mode, since every one of them reads", async () => {
    const test = await harness(
      { "accounts.getAccounts": { data: { accounts: [account] } } },
      {
        readOnly: true,
      },
    );
    try {
      const { resources } = await test.client.listResources();
      assert.ok(resources.length > 0);
      const read = await test.client.readResource({ uri: `ynab://plans/${PLAN_ID}/accounts` });
      assert.ok(read.contents.length > 0);
    } finally {
      await test.close();
    }
  });
});

describe("resource links from list_transactions", () => {
  const reply = { "transactions.getTransactions": { data: { transactions: [transaction] } } };

  it("sends links instead of bodies when asked", async () => {
    const test = await harness(reply);
    try {
      const result = await test.call("list_transactions", { as_links: true });
      const data = result.structuredContent as Record<string, unknown>;

      assert.ok(!("transactions" in data), "full bodies came back anyway");
      assert.equal(result.content.length, 1);
      const [block] = result.content;
      assert.equal(block?.type, "resource_link");
      assert.equal(block?.uri, transactionUri(PLAN_ID, transaction.id));
      // The summary is what lets a model choose without reading anything.
      assert.match(String(block?.description), /2026-08-14.*Local Market.*\$15\.50/);
    } finally {
      await test.close();
    }
  });

  it("leaves the default path exactly as it was", async () => {
    const test = await harness(reply);
    try {
      const result = await test.call("list_transactions");
      assert.equal(result.content[0]?.type, "text");
      assert.ok((result.structuredContent as Record<string, unknown>).transactions);
    } finally {
      await test.close();
    }
  });

  it("hands back a link that resolves to the transaction it names", async () => {
    const test = await harness({
      ...reply,
      "transactions.getTransactionById": { data: { transaction } },
    });
    try {
      const result = await test.call("list_transactions", { as_links: true });
      const [block] = result.content;
      assert.equal(block?.type, "resource_link");
      const read = await test.client.readResource({ uri: block.uri });

      const body = JSON.parse(bodyOf(read)) as { transaction: { id: string } };
      assert.equal(body.transaction.id, transaction.id);
    } finally {
      await test.close();
    }
  });
});
