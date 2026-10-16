import { z } from "zod";
import { RecordStatus, type Prisma } from "@prisma/client";
import { AppError } from "@/lib/errors";
import { assertCompanyAccess, type AccessContext } from "@/lib/access";
import { computeLine, dec, isIntraState, sumTotals, zDecimal, type Decimal } from "@/lib/money";
import { ratesOn } from "@/features/finance/setup";

/** Line fields without the free-text rule (documents that copy lines extend this). */
export const lineFieldsSchema = z.object({
    productId: z.string().min(1).nullish(),
    description: z.string().trim().max(1000).nullish(),
    quantity: zDecimal({ places: 4 }).refine((q) => q.gt(0), "Quantity must be greater than zero"),
    uomId: z.string().min(1).nullish(),
    unitPrice: zDecimal().nullish(),
    discountPercent: zDecimal({ max: 100 }).nullish(),
    taxRateId: z.string().min(1).nullish(),
});

export const lineInputSchema = lineFieldsSchema.refine((l) => l.productId || (l.description && l.unitPrice), {
  message: "Free-text lines need a description and unit price",
  path: ["description"],
});

export type LineInputData = z.infer<typeof lineInputSchema>;

export const linesSchema = z.array(lineInputSchema).min(1, "Add at least one line").max(200);

/**
 * Price document lines. Unit price falls back to the customer's negotiated price,
 * then the product's list price; tax rate falls back to the product's rate and is
 * snapshotted on the line.
 */
export async function priceLines(
  db: Prisma.TransactionClient,
  organizationId: string,
  lines: LineInputData[],
  opts: {
    intraState: boolean;
    customerId?: string;
    priceField?: "salesPrice" | "purchasePrice";
    /** Document date: picks the GST rate version in force (default today) */
    date?: Date;
  },
) {
  const productIds = [...new Set(lines.map((l) => l.productId).filter((id): id is string => Boolean(id)))];
  const products = await db.product.findMany({ where: { organizationId, id: { in: productIds } } });
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const id of productIds) {
    const product = byId.get(id);
    if (!product) throw new AppError("INVALID_REFERENCE", "Product not found", 422);
    if (product.status !== RecordStatus.ACTIVE) {
      throw new AppError("INVALID_STATE", `Product ${product.sku} is not active`, 422);
    }
  }
  const customerPrices = opts.customerId
    ? new Map(
        (await db.customerPrice.findMany({ where: { organizationId, customerId: opts.customerId, productId: { in: productIds } } })).map(
          (p) => [p.productId, p.unitPrice],
        ),
      )
    : new Map<string, Decimal>();

  const taxIds = [
    ...new Set(
      lines
        .map((l) => (l.taxRateId === undefined && l.productId ? byId.get(l.productId)?.taxRateId : l.taxRateId))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const taxRates = new Map(
    (await db.taxRate.findMany({ where: { organizationId, id: { in: taxIds } } })).map((t) => [t.id, t]),
  );
  const ratesInForce = await ratesOn(db, organizationId, taxIds, opts.date ?? new Date());

  const priced = lines.map((line, index) => {
    const product = line.productId ? byId.get(line.productId) : undefined;
    const taxRateId = line.taxRateId === undefined ? product?.taxRateId ?? null : line.taxRateId ?? null;
    const tax = taxRateId ? taxRates.get(taxRateId) : undefined;
    if (taxRateId && !tax) throw new AppError("INVALID_REFERENCE", "Tax rate not found", 422);
    if (tax && !tax.isActive) throw new AppError("INVALID_STATE", `Tax rate ${tax.name} is inactive`, 422);

    const unitPrice =
      line.unitPrice ??
      (product && opts.customerId ? customerPrices.get(product.id) : undefined) ??
      dec(product?.[opts.priceField ?? "salesPrice"]);
    const discountPercent = line.discountPercent ?? dec(0);
    const taxRate = tax ? dec(ratesInForce.get(tax.id) ?? tax.rate) : dec(0);
    const amounts = computeLine({ quantity: line.quantity, unitPrice, discountPercent, taxRate }, opts.intraState);
    return {
      sortOrder: index,
      productId: product?.id ?? null,
      description: line.description || product?.name || "",
      quantity: line.quantity,
      uomId: line.uomId ?? product?.uomId ?? null,
      unitPrice,
      discountPercent,
      taxRateId,
      taxRate,
      ...amounts,
    };
  });
  return {
    lines: priced,
    totals: sumTotals(priced),
    /** GSTR-1 supply category per line (aligned with `lines`) */
    taxKinds: priced.map((l) => (l.taxRateId ? taxRates.get(l.taxRateId)?.kind ?? "TAXABLE" : "NON_GST")),
  };
}

/** The priced fields of a stored line, for copying it onto another document. */
export function copyLine<T extends {
  sortOrder: number; productId: string | null; description: string; quantity: Decimal; uomId: string | null;
  unitPrice: Decimal; discountPercent: Decimal; taxRateId: string | null; taxRate: Decimal; grossAmount: Decimal;
  discountAmount: Decimal; taxableAmount: Decimal; cgstAmount: Decimal; sgstAmount: Decimal; igstAmount: Decimal;
  taxAmount: Decimal; lineTotal: Decimal;
}>(l: T) {
  return {
    sortOrder: l.sortOrder, productId: l.productId, description: l.description, quantity: l.quantity, uomId: l.uomId,
    unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRateId: l.taxRateId, taxRate: l.taxRate,
    grossAmount: l.grossAmount, discountAmount: l.discountAmount, taxableAmount: l.taxableAmount,
    cgstAmount: l.cgstAmount, sgstAmount: l.sgstAmount, igstAmount: l.igstAmount, taxAmount: l.taxAmount, lineTotal: l.lineTotal,
  };
}

export const partyHeaderSchema = z.object({
  companyId: z.string().min(1),
  branchId: z.string().min(1),
  customerId: z.string().min(1),
  contactId: z.string().min(1).nullish(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  placeOfSupplyState: z.string().regex(/^[0-9]{2}$/).nullish(),
});

/**
 * Checks company/branch scope and that customer/contact belong to the tenant, and
 * works out whether the sale is intra-state (branch state vs place of supply).
 */
export async function resolveSalesParty(
  db: Prisma.TransactionClient,
  ctx: AccessContext,
  header: { companyId: string; branchId: string; customerId: string; contactId?: string | null; placeOfSupplyState?: string | null },
) {
  assertCompanyAccess(ctx, header.companyId, header.branchId);
  const [branch, customer] = await Promise.all([
    db.branch.findFirst({
      where: { id: header.branchId, companyId: header.companyId, organizationId: ctx.organizationId },
      include: { company: { select: { stateCode: true, baseCurrency: true, settings: true } } },
    }),
    db.customer.findFirst({ where: { id: header.customerId, organizationId: ctx.organizationId } }),
  ]);
  if (!branch) throw new AppError("NOT_FOUND", "Branch not found", 404);
  if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);
  if (customer.status !== RecordStatus.ACTIVE) throw new AppError("INVALID_STATE", "Customer is not active", 422);
  if (header.contactId) {
    const contact = await db.contact.findFirst({
      where: { id: header.contactId, organizationId: ctx.organizationId, customerId: customer.id },
      select: { id: true },
    });
    if (!contact) throw new AppError("INVALID_REFERENCE", "Contact does not belong to this customer", 422);
  }
  const placeOfSupplyState = header.placeOfSupplyState ?? customer.stateCode ?? null;
  const sellerState = branch.stateCode ?? branch.company.stateCode;
  return {
    branch,
    customer,
    placeOfSupplyState,
    currency: branch.company.baseCurrency,
    companySettings: branch.company.settings,
    intraState: isIntraState(sellerState, placeOfSupplyState),
  };
}
