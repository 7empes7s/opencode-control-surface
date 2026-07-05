/** Applies a percentage tax on top of an amount, in integer cents. */
export function applyTax(amountCents: number, taxRatePercent: number): number {
  if (taxRatePercent < 0) {
    throw new Error("taxRatePercent must be >= 0");
  }
  return Math.round((amountCents * (100 + taxRatePercent)) / 100);
}
