/**
 * Facts about upstream that this codebase depends on. Every assertion here
 * fails the day one of them moves, and says what decision that opens — see
 * AGENTS.md, "Detecting drift". Nothing here touches the network: the SDK is
 * in `node_modules` and YNAB's spec is committed under `spec/`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as ynab from "ynab";
import { DELTA } from "../src/cache.ts";
import { createServer } from "../src/server.ts";
import {
  MAX_CATEGORY_GROUP_NAME,
  MAX_IMPORT_ID,
  MAX_MEMO,
  MAX_PAYEE_NAME,
  MAX_TRANSACTION_PAYEE_NAME,
} from "../src/tools/write-arguments.ts";
import { fakeClient } from "./helpers/fake-client.ts";
import { harness } from "./helpers/server.ts";

const SPEC = fileURLToPath(new URL("../spec/open_api_spec.yaml", import.meta.url));

describe("the YNAB SDK's enums still match ours", () => {
  const cases: readonly (readonly [string, Record<string, string>, string])[] = [
    ["account type", ynab.SaveAccountType, "create_account"],
    ["cleared", ynab.TransactionClearedStatus, "create_transaction"],
    ["flag colour", ynab.TransactionFlagColor, "create_transaction"],
  ];

  for (const [what, sdkEnum, tool] of cases) {
    it(`${what} — if this fails, ${tool}'s enum has to grow`, async () => {
      const test = await harness();
      try {
        const { tools } = await test.client.listTools();
        const schema = tools.find((entry) => entry.name === tool)?.inputSchema;
        const declared = JSON.stringify(schema);
        for (const value of Object.values(sdkEnum)) {
          assert.ok(
            declared.includes(JSON.stringify(value)),
            `the SDK accepts ${JSON.stringify(value)} and ${tool} does not offer it`,
          );
        }
      } finally {
        await test.close();
      }
    });
  }

  it("frequency — thirteen values, unchanged since at least 2022", () => {
    assert.equal(Object.values(ynab.ScheduledTransactionFrequency).length, 13);
  });
});

describe("the SDK still drops goal_frequency", () => {
  it("if this fails, update_category can finally set a cadence", () => {
    // Spec 1.86.0 declares it; SDK 4.5.0 was generated from 1.85.0 and its
    // serialiser returns a hard-coded six-key object. See "Category structure".
    const body = ynab.NewCategoryToJSON({
      name: "Vet",
      goal_target: 1000,
      goal_frequency: "monthly",
    } as never);
    assert.ok(
      !("goal_frequency" in (body as object)),
      "the SDK now forwards goal_frequency — expose it on create_category and update_category",
    );
    assert.ok(
      loadSpec().includes("goal_frequency"),
      "the spec no longer declares goal_frequency — this whole gap may have closed",
    );
  });
});

describe("lastKnowledgeOfServer is where the cache thinks it is", () => {
  const declarations = readFileSync(
    fileURLToPath(new URL("../node_modules/ynab/dist/apis/TransactionsApi.d.ts", import.meta.url)),
    "utf8",
  );

  for (const [name, delta] of Object.entries(DELTA)) {
    const method = name.split(".")[1] ?? "";
    it(`${method} takes it at argument ${delta.at}`, () => {
      const source = declarations.includes(`${method}(planId`)
        ? declarations
        : readFileSync(
            fileURLToPath(
              new URL(`../node_modules/ynab/dist/apis/${apiFor(name)}.d.ts`, import.meta.url),
            ),
            "utf8",
          );

      const signature = new RegExp(`^\\s+${method}\\(([^)]*)\\)`, "m").exec(source);
      assert.ok(signature, `${method} is no longer declared`);

      const parameters = (signature[1] ?? "")
        .split(/,(?![^<]*>)/)
        .map((part) => part.trim().split(/[:?]/)[0]?.trim())
        .filter((part) => part !== undefined && part !== "" && part !== "initOverrides");

      assert.equal(
        parameters[delta.at],
        "lastKnowledgeOfServer",
        `the cache appends knowledge at ${delta.at}, where the SDK now has ` +
          `${parameters[delta.at]} — delta refresh would corrupt this call`,
      );
    });
  }
});

describe("the MCP SDK still lacks what we are waiting on", () => {
  it("no ttlMs or cacheScope — if this fails, set them on results carrying budget data", async () => {
    const types = readFileSync(
      fileURLToPath(
        new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js", import.meta.url),
      ),
      "utf8",
    );
    assert.ok(
      !types.includes("cacheScope") && !types.includes("ttlMs"),
      'revision 2026-07-28 has landed: set cacheScope "private" on anything carrying budget data',
    );
  });

  it("tools/call still fails without `arguments` — if this fails, delete the workaround", async () => {
    // Connected deliberately *without* `connect`, which is what patches this.
    const server = createServer(fakeClient({ "user.getUser": { data: { user: { id: "u" } } } }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "drift", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.request(
        { method: "tools/call", params: { name: "get_user" } },
        CallToolResultSchema,
      );
      assert.equal(
        result.isError,
        true,
        "the SDK now accepts a call with no `arguments` — delete the `onmessage` wrapper in " +
          "src/server.ts and the AGENTS.md section explaining it",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("input schemas still declare draft-07, which is the ENG-22 deviation", async () => {
    const test = await harness();
    try {
      const { tools } = await test.client.listTools();
      for (const tool of tools) {
        assert.equal(
          (tool.inputSchema as { $schema?: string }).$schema,
          "http://json-schema.org/draft-07/schema#",
        );
      }
    } finally {
      await test.close();
    }
  });
});

describe("YNAB's spec still declares the caps we enforce", () => {
  // The SDK's generated models drop every one of these, so the committed spec is
  // the only place they can be checked — and they are checked against the
  // constants the tools actually use, not against a second copy in this file.
  const enforced: Readonly<Record<string, readonly number[]>> = {
    import_id: [MAX_IMPORT_ID],
    memo: [MAX_MEMO],
    payee_name: [MAX_TRANSACTION_PAYEE_NAME],
    // A payee's own name and a category group's, which share a property name.
    name: [MAX_CATEGORY_GROUP_NAME, MAX_PAYEE_NAME].sort((a, b) => a - b),
  };

  for (const [property, caps] of Object.entries(enforced)) {
    it(`${property}: the spec says ${caps.join(" and ")}, and so do we`, () => {
      assert.deepEqual(
        capsIn(loadSpec())[property],
        caps,
        `write-arguments.ts and the spec disagree about ${property}`,
      );
    });
  }

  it("declares no cap we are not enforcing", () => {
    assert.deepEqual(Object.keys(capsIn(loadSpec())).sort(), Object.keys(enforced).sort());
  });
});

/** The committed spec, read once per assertion that needs it. */
function loadSpec(): string {
  return readFileSync(SPEC, "utf8");
}

/** Which API file declares a method, given its `group.method` key. */
function apiFor(name: string): string {
  const group = name.split(".")[0] ?? "";
  return `${group.charAt(0).toUpperCase()}${group.slice(1)}Api`;
}

/**
 * Every `maxLength` in the spec, paired with the property it constrains. The
 * spec is YAML and this is not a parser: a `maxLength` belongs to the nearest
 * preceding key at a shallower indent, which is enough to check a flat set of
 * constants without taking on a dependency for it.
 */
function capsIn(spec: string): Record<string, number[]> {
  const lines = spec.split("\n");
  const found: Record<string, Set<number>> = {};

  for (const [index, line] of lines.entries()) {
    const cap = /^(\s+)maxLength:\s*(\d+)/.exec(line);
    if (cap === null) continue;
    const indent = (cap[1] ?? "").length;

    for (let above = index - 1; above >= 0; above--) {
      const key = /^(\s*)([a-z_]+):\s*$/.exec(lines[above] ?? "");
      if (key === null || (key[1] ?? "").length >= indent) continue;
      const property = key[2] ?? "";
      found[property] ??= new Set();
      found[property].add(Number(cap[2]));
      break;
    }
  }

  return Object.fromEntries(
    Object.entries(found).map(([property, caps]) => [property, [...caps].sort((a, b) => a - b)]),
  );
}
