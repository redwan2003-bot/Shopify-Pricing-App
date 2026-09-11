/**
 * Decimal currency string → integer cents, with NO binary floating-point.
 *
 * Task 5B.2 §9. Shopify `MoneyV2.amount` is a decimal string. This parser:
 *  - accepts an unsigned integer or an unsigned decimal with 1 or 2 fractional digits
 *    (`"12"`, `"12.9"`, `"12.99"`);
 *  - REJECTS: negatives (`"-1.00"`), exponent notation (`"1e2"`), 3+ fractional digits
 *    (`"1.234"` — unsupported precision), leading `+`, whitespace, empty, non-strings,
 *    thousands separators, and anything else;
 *  - never uses `parseFloat` / `Number()` on the fractional part — it splits on `.` and
 *    does integer arithmetic, so `"0.10"` is exactly `10`, never `9` or `10.000001`.
 *
 * Returns `null` on any rejection. The caller treats `null` as "price not verifiable"
 * and fails closed.
 */

const UNSIGNED_MONEY = /^(\d+)(?:\.(\d{1,2}))?$/;

export function decimalStringToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = UNSIGNED_MONEY.exec(value);
  if (!match) return null;

  const whole = match[1]!;
  const frac = match[2] ?? "";

  // Bound the integer part so `whole * 100` stays a safe integer.
  if (whole.length > 12) return null;

  const wholeCents = Number(whole) * 100;
  const fracCents = frac.length === 0 ? 0 : Number(frac.padEnd(2, "0"));
  const cents = wholeCents + fracCents;

  if (!Number.isSafeInteger(cents) || cents < 0) return null;
  return cents;
}
