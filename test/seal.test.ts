/**
 * The primitives every remote secret goes through. Small, because the point
 * is only that a wrong key, a flipped byte or a forged signature fails loudly.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSealer, fingerprint, randomSecret } from "../src/remote/seal.ts";

const KEY = Buffer.alloc(32, 1);
const OTHER = Buffer.alloc(32, 2);

describe("the sealer", () => {
  it("round-trips, and two seals of one value differ", () => {
    const sealer = createSealer(KEY);
    const a = sealer.seal("ynab-token");
    const b = sealer.seal("ynab-token");
    assert.notEqual(a, b, "a repeated seal is deterministic — the IV is not random");
    assert.equal(sealer.open(a), "ynab-token");
    assert.equal(sealer.open(b), "ynab-token");
  });

  it("refuses a tampered or foreign seal", () => {
    const sealer = createSealer(KEY);
    const sealed = sealer.seal("ynab-token");
    const bytes = Buffer.from(sealed, "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    assert.throws(() => sealer.open(bytes.toString("base64url")));
    assert.throws(() => createSealer(OTHER).open(sealed));
    assert.throws(() => sealer.open("short"));
  });

  it("signs, verifies, and refuses a forged or foreign signature", () => {
    const sealer = createSealer(KEY);
    const signed = sealer.sign("state-value");
    assert.equal(sealer.verify(signed), "state-value");
    assert.equal(sealer.verify(`${signed}x`), undefined);
    assert.equal(sealer.verify("state-value.forged"), undefined);
    assert.equal(sealer.verify("no-dot"), undefined);
    assert.equal(createSealer(OTHER).verify(signed), undefined);
  });

  it("wants exactly 32 bytes", () => {
    assert.throws(() => createSealer(Buffer.alloc(16)), RangeError);
  });

  it("fingerprints are stable, and secrets are not", () => {
    assert.equal(fingerprint("a"), fingerprint("a"));
    assert.notEqual(fingerprint("a"), fingerprint("b"));
    assert.notEqual(randomSecret(), randomSecret());
    assert.ok(randomSecret().length >= 43);
  });
});
