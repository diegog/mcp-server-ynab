/**
 * Milliunits round-trip exactly, or not at all. The failure mode this guards
 * against is a transaction off by 1000x — see AGENTS.md, "Money on the write path".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolError } from "../src/errors.ts";
import { toMilliunits } from "../src/money.ts";

describe("toMilliunits", () => {
  const exact: readonly (readonly [number, number])[] = [
    [0, 0],
    [1, 1000],
    [-1, -1000],
    // The case that makes this a digit shift rather than a multiplication:
    // 123.93 * 1000 is 123930.00000000001 in IEEE 754.
    [123.93, 123_930],
    [-123.93, -123_930],
    [0.001, 1],
    [-0.001, -1],
    [0.1, 100],
    [0.12, 120],
    [1.005, 1005],
    [999_999.999, 999_999_999],
    [-0.07, -70],
    [8.29, 8290],
    [2.675, 2675],
  ];

  for (const [amount, milliunits] of exact) {
    it(`converts ${amount} to ${milliunits}`, () => {
      assert.equal(toMilliunits(amount, "amount"), milliunits);
    });
  }

  it("never multiplies, so no conversion carries a float artefact", () => {
    for (const [amount] of exact) {
      assert.ok(Number.isInteger(toMilliunits(amount, "amount")));
    }
  });

  it("round-trips back to the amount it was given", () => {
    for (const [amount, milliunits] of exact) {
      assert.equal(milliunits / 1000, amount);
    }
  });

  it("passes undefined through rather than defaulting to zero", () => {
    // `args.amount ?? 0` on an update would overwrite a real amount with nothing.
    assert.equal(toMilliunits(undefined, "amount"), undefined);
  });

  const refused: readonly number[] = [
    0.0001,
    -0.0001,
    1.2345,
    123.9301,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];

  for (const amount of refused) {
    it(`refuses ${amount} rather than rounding it`, () => {
      // Rounding a too-precise amount is what turns a mistake into a plausible
      // number, so the rejection is the feature.
      assert.throws(() => toMilliunits(amount, "amount"), ToolError);
    });
  }

  it("names the argument in the failure, so the model can fix the right field", () => {
    assert.throws(
      () => toMilliunits(1.2345, "transactions[2].amount"),
      (error: unknown) =>
        error instanceof ToolError && error.message.includes("transactions[2].amount"),
    );
  });
});
