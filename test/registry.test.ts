/**
 * Every tool is fully defined, and read-only mode withholds exactly the writes.
 * Cheap to run, and it means a new tool cannot ship half-described.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOOLS } from "../src/tools/index.ts";
import { harness, textOf } from "./helpers/server.ts";

const NAME = /^[a-z][a-z0-9_]*$/;

describe("tool definitions", () => {
  for (const tool of TOOLS) {
    describe(tool.name, () => {
      it("is named in snake_case with no prefix", () => {
        assert.match(tool.name, NAME);
      });

      it("carries a title and a description worth reading", () => {
        assert.ok(tool.title.length > 0, "title is empty");
        // Long enough to say what the tool is for, not just restate its name.
        assert.ok(tool.description.length > 80, `description is ${tool.description.length} chars`);
      });

      it("declares an output schema", () => {
        assert.ok(Object.keys(tool.outputSchema).length > 0, "outputSchema is empty");
      });

      it("states all four behaviour hints", () => {
        for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
          assert.equal(
            typeof tool.annotations[hint as keyof typeof tool.annotations],
            "boolean",
            `${hint} is not stated`,
          );
        }
      });

      it("is closed-world, since every entity is the token holder's own", () => {
        assert.equal(tool.annotations.openWorldHint, false);
      });

      it("takes plan_id, or is one of the two tools that cannot", () => {
        const takesPlan = "plan_id" in tool.inputSchema;
        const exempt = tool.name === "get_user" || tool.name === "list_plans";
        assert.equal(takesPlan, !exempt, `plan_id present: ${takesPlan}, exempt: ${exempt}`);
      });
    });
  }

  it("has no duplicate names", () => {
    const names = TOOLS.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length);
  });

  it("marks a write as destructive or additive but never read-only", () => {
    const writes = TOOLS.filter((tool) => !tool.annotations.readOnlyHint);
    assert.ok(writes.length > 0, "no write tools registered");
    for (const tool of writes) {
      assert.match(tool.name, /^(create|update|delete|set|import)_/);
    }
  });

  it("names every read tool get_ or list_", () => {
    for (const tool of TOOLS.filter((tool) => tool.annotations.readOnlyHint)) {
      assert.match(tool.name, /^(get|list)_/);
    }
  });
});

describe("registration", () => {
  it("serves tools in codepoint order, so a client can cache the prompt prefix", async () => {
    const test = await harness();
    try {
      const { tools } = await test.client.listTools();
      const names = tools.map((tool) => tool.name);
      assert.deepEqual(names, [...names].sort());
      assert.equal(names.length, TOOLS.length);
    } finally {
      await test.close();
    }
  });

  it("withholds every write in read-only mode", async () => {
    const test = await harness({}, { readOnly: true });
    try {
      const { tools } = await test.client.listTools();
      const served = new Set(tools.map((tool) => tool.name));
      for (const tool of TOOLS) {
        assert.equal(
          served.has(tool.name),
          tool.annotations.readOnlyHint,
          `${tool.name} served: ${served.has(tool.name)}`,
        );
      }
    } finally {
      await test.close();
    }
  });

  it("answers a withheld tool with not-found, never with disabled", async () => {
    const test = await harness({}, { readOnly: true });
    try {
      const result = await test.call("set_category_budget", {
        month: "current",
        category_id: "c",
        amount: 1,
      });
      // `McpServer` returns even an unknown tool as an `isError` result rather
      // than a JSON-RPC error — see AGENTS.md, "Error mapping".
      assert.equal(result.isError, true);
      assert.match(textOf(result), /not found/i);
      // Never "disabled": that would confirm the write surface exists and invite
      // the model to ask for it to be turned on.
      assert.doesNotMatch(textOf(result), /disabled/i);
      assert.equal(test.ynab.calls.length, 0, "a withheld tool must not reach YNAB");
    } finally {
      await test.close();
    }
  });
});
