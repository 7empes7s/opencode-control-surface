import { applyDiscount } from "./discount.ts";
import { applyTax } from "./tax.ts";

/**
 * Computes the final total (in integer cents) for a checkout: the discount is
 * applied to the subtotal first, then tax is applied on top of the discounted
 * amount. This ordering matters for anyone auditing a receipt against a
 * published price list, so it is covered explicitly by tests.
 */
export function computeTotalCents(
  subtotalCents: number,
  discountPercent: number,
  taxRatePercent: number,
): number {
  const discounted = applyDiscount(subtotalCents, discountPercent);
  return applyTax(discounted, taxRatePercent);
}
