/**
 * Decimal amounts in, milliunits out. See AGENTS.md, "Money on the write path".
 */
import { z } from "zod";
import { ToolError } from "./errors.ts";

/** Decimal places a milliunit expresses: YNAB stores one dollar as `1000`. */
const PLACES = 3;

/** Said on every money argument, so the unit is never inferred from a name. */
const UNIT =
  "A decimal amount in the plan's currency, never milliunits: pass 123.93 for $123.93, " +
  "not 123930. At most three decimal places — anything finer is rejected rather than " +
  "rounded, because silently altering a financial amount is worse than failing.";

/** Not guessable from the API, and the sign is half the meaning of the number. */
const SIGN =
  "Outflows are negative and inflows positive: -123.93 records spending 123.93, and " +
  "123.93 records receiving it.";

/** A money argument. Convert it with {@link toMilliunits} before sending it on. */
export function moneyArgument(meaning: string): z.ZodNumber {
  return z.number().describe(`${meaning} ${UNIT}`);
}

/** A money argument on a transaction, which additionally carries YNAB's sign convention. */
export function transactionAmountArgument(meaning: string): z.ZodNumber {
  return z.number().describe(`${meaning} ${UNIT} ${SIGN}`);
}

/**
 * The milliunits YNAB stores for `amount`, or {@link ToolError} if that is not
 * exactly representable. `field` names the argument in the failure.
 */
export function toMilliunits(amount: number, field: string): number;
export function toMilliunits(amount: number | undefined, field: string): number | undefined;
export function toMilliunits(amount: number | undefined, field: string): number | undefined {
  // Undefined passes through so an optional amount cannot be defaulted to zero,
  // which on an update would overwrite a real amount with nothing.
  if (amount === undefined) return undefined;

  if (!Number.isFinite(amount)) {
    throw new ToolError(`\`${field}\` must be a finite decimal amount, not ${amount}.`);
  }

  const milliunits = shiftPointRight(amount, PLACES);
  if (milliunits === undefined) {
    throw new ToolError(
      `\`${field}\` is ${amount}, which is finer than YNAB can store. Amounts go to three ` +
        "decimal places at most. Round it yourself and call again — the server will not " +
        "round a financial amount on your behalf.",
    );
  }
  if (!Number.isSafeInteger(milliunits)) {
    throw new ToolError(
      `\`${field}\` is ${amount}, which is too large to convert to milliunits exactly. ` +
        "Amounts this size are almost always a mistake; check the value with the user.",
    );
  }
  return milliunits;
}

/** The shortest decimal string that round-trips a double, which is what `toString` gives. */
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/**
 * `value` with the decimal point moved `places` to the right, exactly, or
 * `undefined` if that would discard a non-zero digit. Digit strings rather than
 * `value * 1000`, which for 123.93 lands on 123930.00000000001.
 */
function shiftPointRight(value: number, places: number): number | undefined {
  const parts = DECIMAL.exec(value.toString());
  if (parts === null) return undefined;
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = parts;

  const digits = whole + fraction;
  const shift = Number(exponent) - fraction.length + places;
  if (shift >= 0) return Number(`${sign}${digits}${"0".repeat(shift)}`);

  const padded = digits.padStart(-shift, "0");
  const kept = padded.slice(0, shift);
  if (/[^0]/.test(padded.slice(shift))) return undefined;
  return Number(`${sign}${kept || "0"}`);
}
