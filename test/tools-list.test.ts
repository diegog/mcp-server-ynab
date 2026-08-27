/**
 * A committed snapshot of `tools/list`. Schema drift is the failure mode that
 * degrades model behaviour without breaking anything, so the diff has to be
 * visible in review rather than discovered in use.
 *
 * Regenerate deliberately: `UPDATE_SNAPSHOTS=1 npm test`.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { harness } from "./helpers/server.ts";

const SNAPSHOT = fileURLToPath(new URL("./snapshots/tools-list.json", import.meta.url));

describe("tools/list", () => {
  it("matches the committed snapshot", async () => {
    const test = await harness();
    try {
      const { tools } = await test.client.listTools();
      const actual = `${JSON.stringify(tools, null, 2)}\n`;

      if (process.env.UPDATE_SNAPSHOTS) {
        writeFileSync(SNAPSHOT, actual);
        return;
      }

      const expected = readFileSync(SNAPSHOT, "utf8");
      if (actual !== expected) {
        assert.deepEqual(
          JSON.parse(actual),
          JSON.parse(expected),
          "tools/list drifted from the snapshot. If the change is intended, " +
            "regenerate with `UPDATE_SNAPSHOTS=1 npm test` and review the diff.",
        );
        // Same JSON, different bytes — formatting only.
        assert.equal(actual, expected);
      }
    } finally {
      await test.close();
    }
  });

  it("declares a JSON Schema draft on every tool", async () => {
    const test = await harness();
    try {
      const { tools } = await test.client.listTools();
      for (const tool of tools) {
        // draft-07 is what the SDK hard-codes for zod v4 schemas; ENG-22 asked
        // for 2020-12. See AGENTS.md, "Omitted tool arguments".
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
