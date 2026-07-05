/** Applies a percentage discount to a subtotal, in integer cents. */
export function applyDiscount(subtotalCents: number, discountPercent: number): number {
  if (discountPercent < 0 || discountPercent > 100) {
    throw new Error("discountPercent must be between 0 and 100");
  }
  return Math.round((subtotalCents * (100 - discountPercent)) / 100);
}
