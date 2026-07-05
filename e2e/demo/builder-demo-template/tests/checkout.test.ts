import { describe, expect, test } from "bun:test";
import { applyDiscount } from "../src/discount.ts";
import { applyTax } from "../src/tax.ts";
import { computeTotalCents } from "../src/checkout.ts";

describe("applyDiscount", () => {
  test("10% off $10.00 is $9.00", () => {
    expect(applyDiscount(1000, 10)).toBe(900);
  });

  test("0% off leaves the subtotal unchanged", () => {
    expect(applyDiscount(1000, 0)).toBe(1000);
  });

  test("100% off is free", () => {
    expect(applyDiscount(1000, 100)).toBe(0);
  });

  test("rejects out-of-range percentages", () => {
    expect(() => applyDiscount(1000, 150)).toThrow();
    expect(() => applyDiscount(1000, -5)).toThrow();
  });
});

describe("applyTax", () => {
  test("8% tax on $10.00 is $10.80", () => {
    expect(applyTax(1000, 8)).toBe(1080);
  });

  test("0% tax leaves the amount unchanged", () => {
    expect(applyTax(1000, 0)).toBe(1000);
  });

  test("rejects a negative tax rate", () => {
    expect(() => applyTax(1000, -1)).toThrow();
  });
});

describe("computeTotalCents", () => {
  test("$20 subtotal, 25% discount, then 10% tax on the discounted amount", () => {
    // discount first: 2000 -> 1500, then tax: 1500 * 1.10 = 1650
    expect(computeTotalCents(2000, 25, 10)).toBe(1650);
  });

  test("no discount, no tax returns the subtotal unchanged", () => {
    expect(computeTotalCents(999, 0, 0)).toBe(999);
  });
});
