import { Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * Decimal-safe money/quantity maths (decimal.js via Prisma.Decimal). Never use JS
 * floats for amounts: API values arrive and leave as strings.
 */
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

export const dec = (value: Prisma.Decimal.Value | null | undefined) => new Decimal(value ?? 0);
/** Half-up to 2 dp (money). */
export const money = (value: Prisma.Decimal.Value) => dec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** zod: decimal from string/number, finite, with bounds and max decimal places. */
export function zDecimal({ min = 0, max = 1e12, places = 2 }: { min?: number; max?: number; places?: number } = {}) {
  return z
    .union([z.string().trim().min(1), z.number()])
    .transform((value, ctx) => {
      try {
        const d = new Decimal(value);
        if (!d.isFinite()) throw new Error();
        if (d.lt(min) || d.gt(max)) {
          ctx.addIssue({ code: "custom", message: `Must be between ${min} and ${max}`, fatal: true });
          return z.NEVER;
        }
        if (d.decimalPlaces() > places) {
          ctx.addIssue({ code: "custom", message: `At most ${places} decimal places`, fatal: true });
          return z.NEVER;
        }
        return d;
      } catch {
        ctx.addIssue({ code: "custom", message: "Must be a number", fatal: true });
        return z.NEVER;
      }
    });
}

export type LineInput = {
  quantity: Decimal;
  unitPrice: Decimal;
  discountPercent: Decimal;
  taxRate: Decimal;
};

export type LineAmounts = {
  grossAmount: Decimal;
  discountAmount: Decimal;
  taxableAmount: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
};

/**
 * One document line. Prices are tax-exclusive. Intra-state supply splits GST equally
 * into CGST + SGST (each rounded, so tax = 2 x half); inter-state supply is IGST.
 */
export function computeLine(line: LineInput, intraState: boolean): LineAmounts {
  const grossAmount = money(line.quantity.mul(line.unitPrice));
  const discountAmount = money(grossAmount.mul(line.discountPercent).div(100));
  const taxableAmount = grossAmount.sub(discountAmount);
  const zero = new Decimal(0);
  let cgstAmount = zero;
  let sgstAmount = zero;
  let igstAmount = zero;
  if (intraState) {
    cgstAmount = money(taxableAmount.mul(line.taxRate).div(200));
    sgstAmount = cgstAmount;
  } else {
    igstAmount = money(taxableAmount.mul(line.taxRate).div(100));
  }
  const taxAmount = cgstAmount.add(sgstAmount).add(igstAmount);
  return {
    grossAmount,
    discountAmount,
    taxableAmount,
    cgstAmount,
    sgstAmount,
    igstAmount,
    taxAmount,
    lineTotal: taxableAmount.add(taxAmount),
  };
}

export function sumTotals(lines: LineAmounts[]) {
  const sum = (key: keyof LineAmounts) => lines.reduce((acc, l) => acc.add(l[key]), new Decimal(0));
  return {
    subtotal: sum("grossAmount"),
    discountTotal: sum("discountAmount"),
    taxableTotal: sum("taxableAmount"),
    taxTotal: sum("taxAmount"),
    grandTotal: sum("lineTotal"),
  };
}

/** Same GST state (or either side unknown) => intra-state. */
export function isIntraState(sellerState?: string | null, placeOfSupply?: string | null) {
  return !sellerState || !placeOfSupply || sellerState === placeOfSupply;
}
