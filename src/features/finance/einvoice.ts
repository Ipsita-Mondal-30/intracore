import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, assertCompanyAccess, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { isStateCode, isValidGstin, isValidHsn } from "@/lib/gst";

/**
 * E-invoice (IRN) support. This module builds and validates the invoice payload in the
 * shape of the government e-invoice schema (v1.1 key fields) and hands it to an
 * explicitly configured provider adapter (a GSP / IRP client). No provider ships with
 * the app: without one, registration fails with NOT_CONFIGURED and nothing is claimed
 * to be registered. E-way bills follow the same adapter pattern (not implemented).
 */

export type EInvoiceResult = { irn: string; ackNo: string; ackDate: string; signedQr?: string };

export interface EInvoiceProvider {
  readonly name: string;
  generateIrn(payload: EInvoicePayload): Promise<EInvoiceResult>;
}

const providers = new Map<string, EInvoiceProvider>();
/** Wire a real adapter (credentials resolved by the integration framework). */
export function setEInvoiceProvider(companyId: string, provider: EInvoiceProvider | null) {
  if (provider) providers.set(companyId, provider);
  else providers.delete(companyId);
}

const fmtDate = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
const num = (v: { toString(): string }) => Number(v.toString());

export type EInvoicePayload = ReturnType<typeof toPayload>;

function toPayload(inv: Awaited<ReturnType<typeof loadInvoice>>) {
  return {
    Version: "1.1",
    TranDtls: { TaxSch: "GST", SupTyp: "B2B", RegRev: inv.reverseCharge ? "Y" : "N" },
    DocDtls: { Typ: "INV", No: inv.number, Dt: fmtDate(inv.invoiceDate) },
    SellerDtls: {
      Gstin: inv.sellerGstin,
      LglNm: inv.company.legalName ?? inv.company.name,
      Addr1: inv.branch.address ?? inv.company.address,
      Stcd: inv.sellerGstin?.slice(0, 2),
    },
    BuyerDtls: {
      Gstin: inv.customerGstin,
      LglNm: inv.customer.legalName ?? inv.customer.name,
      Pos: inv.placeOfSupplyState,
      Addr1: inv.billingAddress,
      Stcd: inv.customerGstin?.slice(0, 2),
    },
    ItemList: inv.lines.map((l, i) => ({
      SlNo: String(i + 1),
      PrdDesc: l.description,
      IsServc: l.hsnCode?.startsWith("99") ? "Y" : "N",
      HsnCd: l.hsnCode,
      Qty: num(l.quantity),
      UnitPrice: num(l.unitPrice),
      TotAmt: num(l.grossAmount),
      Discount: num(l.discountAmount),
      AssAmt: num(l.taxableAmount),
      GstRt: num(l.taxRate),
      IgstAmt: num(l.igstAmount),
      CgstAmt: num(l.cgstAmount),
      SgstAmt: num(l.sgstAmount),
      TotItemVal: num(l.lineTotal),
    })),
    ValDtls: {
      AssVal: num(inv.taxableTotal),
      CgstVal: num(inv.cgstTotal),
      SgstVal: num(inv.sgstTotal),
      IgstVal: num(inv.igstTotal),
      TotInvVal: num(inv.grandTotal),
    },
  };
}

async function loadInvoice(ctx: AccessContext, id: string) {
  const inv = await prisma.salesInvoice.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { lines: { orderBy: { sortOrder: "asc" } }, company: true, branch: true, customer: true },
  });
  if (!inv) throw new AppError("NOT_FOUND", "Invoice not found", 404);
  assertCompanyAccess(ctx, inv.companyId, inv.branchId);
  return inv;
}

/** Payload plus every problem that would make the IRP reject it. */
export async function buildEInvoice(ctx: AccessContext, id: string) {
  assertCan(ctx, "invoice.view");
  const inv = await loadInvoice(ctx, id);
  const errors: string[] = [];
  if (inv.status !== "POSTED" || !inv.number) errors.push("Invoice must be posted");
  if (!isValidGstin(inv.sellerGstin)) errors.push("Seller GSTIN missing or invalid");
  if (!isValidGstin(inv.customerGstin)) errors.push("E-invoices are for B2B supplies: buyer GSTIN missing or invalid");
  if (!isStateCode(inv.placeOfSupplyState)) errors.push("Place of supply missing");
  if (!(inv.branch.address ?? inv.company.address)) errors.push("Seller address missing");
  if (!inv.billingAddress) errors.push("Buyer address missing");
  errors.push("Seller and buyer PIN codes are not captured yet (required by the schema)");
  inv.lines.forEach((l, i) => {
    if (!isValidHsn(l.hsnCode)) errors.push(`Line ${i + 1}: HSN/SAC code missing or invalid`);
  });
  return { payload: toPayload(inv), errors, ready: errors.length === 0, irn: inv.irn, irnStatus: inv.irnStatus };
}

/** Register with the configured provider. Never pretends success without one. */
export async function registerEInvoice(ctx: AccessContext, id: string) {
  assertCan(ctx, "invoice.post");
  const built = await buildEInvoice(ctx, id);
  const inv = await loadInvoice(ctx, id);
  if (inv.irn) return { irn: inv.irn, irnStatus: inv.irnStatus, alreadyRegistered: true };
  const provider = providers.get(inv.companyId);
  if (!provider) throw new AppError("NOT_CONFIGURED", "No e-invoice provider is configured for this company", 422);
  if (!built.ready) throw new AppError("VALIDATION_ERROR", "The invoice is not ready for e-invoicing", 422, built.errors);
  const result = await provider.generateIrn(built.payload);
  await prisma.$transaction(async (tx) => {
    await tx.salesInvoice.update({ where: { id }, data: { irn: result.irn, irnStatus: "GENERATED" } });
    await audit(tx, ctx, { action: "invoice.irn_generated", entity: "sales_invoice", entityId: id, companyId: inv.companyId, next: { irn: result.irn, ackNo: result.ackNo, provider: provider.name } });
  });
  return { ...result, irnStatus: "GENERATED", alreadyRegistered: false };
}
