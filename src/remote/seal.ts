/**
 * Every secret the remote entrypoint keeps, kept the one way: a token we issue
 * is stored as its SHA-256 and never in the clear; a YNAB token is sealed with
 * AES-256-GCM because we have to hand it back; a cookie is signed so a browser
 * cannot forge one. One 32-byte key from the environment, and HKDF derives a
 * separate key for each of the two uses so neither can be turned into the
 * other. See AGENTS.md, "The remote surface".
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** What the environment has to supply: 32 bytes, base64. */
export const KEY_BYTES = 32;

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Sealer {
  /** Encrypt for storage. Output is opaque and safe in a text column. */
  seal(plaintext: string): string;
  /** Decrypt, throwing on anything tampered with or sealed under another key. */
  open(sealed: string): string;
  /** Sign a value for a cookie. */
  sign(value: string): string;
  /** Recover the signed value, or `undefined` when the signature does not hold. */
  verify(signed: string): string | undefined;
}

/** Derive the two working keys from the one master key. */
export function createSealer(masterKey: Buffer): Sealer {
  if (masterKey.length !== KEY_BYTES) {
    throw new RangeError(`sealer key must be ${KEY_BYTES} bytes, got ${masterKey.length}`);
  }
  const sealKey = Buffer.from(hkdfSync("sha256", masterKey, "", "seal", KEY_BYTES));
  const signKey = Buffer.from(hkdfSync("sha256", masterKey, "", "sign", KEY_BYTES));

  return {
    seal(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, sealKey, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
    },
    open(sealed) {
      const bytes = Buffer.from(sealed, "base64url");
      if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("sealed value is too short");
      const decipher = createDecipheriv(ALGORITHM, sealKey, bytes.subarray(0, IV_BYTES));
      decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    },
    sign(value) {
      return `${value}.${mac(signKey, value)}`;
    },
    verify(signed) {
      const at = signed.lastIndexOf(".");
      if (at <= 0) return undefined;
      const value = signed.slice(0, at);
      const given = Buffer.from(signed.slice(at + 1), "base64url");
      const expected = Buffer.from(mac(signKey, value), "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
      return value;
    },
  };
}

function mac(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

/** The form a secret is stored in: its SHA-256, hex. */
export function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** A fresh secret with 256 bits of entropy, URL-safe. */
export function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}
