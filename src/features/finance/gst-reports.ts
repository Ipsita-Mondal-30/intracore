import { z } from "zod";
import { FinanceDocStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { companySettings } from "@/lib/settings";
import { dec, Decimal } from "@/lib/money";
import { GST_STATES, isValidGstin } from "@/lib/gst";

/**
 * GST return PREPARATION (GSTR-1 / GSTR-3B style summaries) from posted documents of
 * one GST registration (seller GSTIN). This is data for review and for an accountant or
 * GSP to file — nothing here files a return. Classification rules (B2B / B2CL / B2CS,
 * thresholds) should be confirmed with a qualified accountant for each period.
 */

const ZERO = new Decimal(0);
const f = (d: Decimal) => d.toFixed(2);
const rangeSchema = z.object({ gstin: z.string().min(15).max(15), from: z.coerce.date(), to: z.coerce.date() });

async function registration(ctx: AccessContext, companyId: string, gstin: string) {
  assertCan(ctx, "finance.report");
  if (!ctx.companies.has(companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  const company = await prisma.company.findFirst({ where: { id: companyId, organizationId: ctx.organizationId }, include: { branches: true } });
  if (!company) throw new AppError("NOT_FOUND", "Company not found", 404);
  const known = [company.gstin, ...company.branches.map((b) => b.gstin)].filter(Boolean);
  if (!known.includes(gstin)) throw new AppError("NOT_FOUND", "GSTIN is not registered to this company", 404);
  return company;
}

type TaxLine = { taxRate: Decimal; taxableAmount: Decimal; cgstAmount: Decimal; sgstAmount: Decimal; igstAmount: Decimal; taxKind: string; hsnCode: string | null; quantity: Decimal; lineTotal: Decimal };

function rateWise(lines: TaxLine[]) {
  const map = new Map<string, { rate: string; taxable: Decimal; igst: Decimal; cgst: Decimal; sgst: Decimal }>();
  for (const l of lines.filter((x) => x.taxKind === "TAXABLE" || x.taxKind === "ZERO_RATED")) {
    const key = l.taxRate.toString();
    const row = map.get(key) ?? { rate: key, taxable: ZERO, igst: ZERO, cgst: ZERO, sgst: ZERO };
    row.taxable = row.taxable.add(l.taxableAmount);
    row.igst = row.igst.add(l.igstAmount);
    row.cgst = row.cgst.add(l.cgstAmount);
    row.sgst = row.sgst.add(l.sgstAmount);
    map.set(key, row);
  }
  return [...map.values()].map((r) => ({ rate: r.rate, taxable: f(r.taxable), igst: f(r.igst), cgst: f(r.cgst), sgst: f(r.sgst) }));
}

const asLines = <T extends { taxRate: unknown; taxableAmount: unknown; cgstAmount: unknown; sgstAmount: unknown; igstAmount: unknown; quantity: unknown; lineTotal: unknown; taxKind: string; hsnCode: string | null }>(lines: T[]): TaxLine[] =>
  lines.map((l) => ({
    taxRate: dec(l.taxRate as Decimal),
    taxableAmount: dec(l.taxableAmount as Decimal),
    cgstAmount: dec(l.cgstAmount as Decimal),
    sgstAmount: dec(l.sgstAmount as Decimal),
    igstAmount: dec(l.igstAmount as Decimal),
    quantity: dec(l.quantity as Decimal),
    lineTotal: dec(l.lineTotal as Decimal),
    taxKind: l.taxKind,
    hsnCode: l.hsnCode,
  }));

export async function gstr1(ctx: AccessContext, companyId: string, query: unknown) {
  const q = rangeSchema.parse(query);
  const company = await registration(ctx, companyId, q.gstin);
  const threshold = companySettings(company.settings).gst.b2clThreshold;
  const sellerState = q.gstin.slice(0, 2);
  const invoices = await prisma.salesInvoice.findMany({
    where: { companyId, sellerGstin: q.gstin, invoiceDate: { gte: q.from, lte: q.to }, status: { in: [FinanceDocStatus.POSTED, FinanceDocStatus.CANCELLED] }, number: { not: null } },
    include: { lines: true },
    orderBy: { invoiceDate: "asc" },
  });
  const live = invoices.filter((i) => i.status === FinanceDocStatus.POSTED);
  const notes = await prisma.creditNote.findMany({
    where: { companyId, status: FinanceDocStatus.POSTED, noteDate: { gte: q.from, lte: q.to }, invoice: { sellerGstin: q.gstin } },
    include: { lines: true, invoice: { select: { number: true, invoiceDate: true, customerGstin: true, placeOfSupplyState: true } } },
  });

  const b2b = live
    .filter((i) => i.customerGstin)
    .map((i) => ({
      customerGstin: i.customerGstin,
      gstinValid: isValidGstin(i.customerGstin),
      invoiceNumber: i.number,
      invoiceDate: i.invoiceDate,
      invoiceValue: f(dec(i.grandTotal)),
      placeOfSupply: i.placeOfSupplyState,
      reverseCharge: i.reverseCharge,
      rates: rateWise(asLines(i.lines)),
    }));
  const unregistered = live.filter((i) => !i.customerGstin);
  const interState = (pos: string | null) => Boolean(pos && pos !== sellerState);
  const b2cl = unregistered
    .filter((i) => interState(i.placeOfSupplyState) && dec(i.grandTotal).gt(threshold))
    .map((i) => ({ invoiceNumber: i.number, invoiceDate: i.invoiceDate, invoiceValue: f(dec(i.grandTotal)), placeOfSupply: i.placeOfSupplyState, rates: rateWise(asLines(i.lines)) }));
  const b2clIds = new Set(b2cl.map((x) => x.invoiceNumber));
  const b2csMap = new Map<string, { placeOfSupply: string | null; rate: string; type: string; taxable: Decimal; igst: Decimal; cgst: Decimal; sgst: Decimal }>();
  for (const inv of unregistered.filter((i) => !b2clIds.has(i.number))) {
    for (const r of asLines(inv.lines).filter((l) => l.taxKind === "TAXABLE")) {
      const key = `${inv.placeOfSupplyState}|${r.taxRate}`;
      const row = b2csMap.get(key) ?? { placeOfSupply: inv.placeOfSupplyState, rate: r.taxRate.toString(), type: interState(inv.placeOfSupplyState) ? "INTER" : "INTRA", taxable: ZERO, igst: ZERO, cgst: ZERO, sgst: ZERO };
      row.taxable = row.taxable.add(r.taxableAmount);
      row.igst = row.igst.add(r.igstAmount);
      row.cgst = row.cgst.add(r.cgstAmount);
      row.sgst = row.sgst.add(r.sgstAmount);
      b2csMap.set(key, row);
    }
  }
  const cdn = notes.map((n) => ({
    registered: Boolean(n.invoice.customerGstin),
    customerGstin: n.invoice.customerGstin,
    noteNumber: n.number,
    noteDate: n.noteDate,
    originalInvoice: n.invoice.number,
    originalInvoiceDate: n.invoice.invoiceDate,
    noteValue: f(dec(n.grandTotal)),
    placeOfSupply: n.invoice.placeOfSupplyState,
    rates: rateWise(asLines(n.lines)),
  }));

  const nil = { nilRated: ZERO, exempt: ZERO, nonGst: ZERO };
  const hsn = new Map<string, { hsn: string; rate: string; quantity: Decimal; value: Decimal; taxable: Decimal; igst: Decimal; cgst: Decimal; sgst: Decimal }>();
  for (const l of live.flatMap((i) => asLines(i.lines))) {
    if (l.taxKind === "NIL_RATED") nil.nilRated = nil.nilRated.add(l.taxableAmount);
    if (l.taxKind === "EXEMPT") nil.exempt = nil.exempt.add(l.taxableAmount);
    if (l.taxKind === "NON_GST") nil.nonGst = nil.nonGst.add(l.taxableAmount);
    const key = `${l.hsnCode ?? "MISSING"}|${l.taxRate}`;
    const row = hsn.get(key) ?? { hsn: l.hsnCode ?? "MISSING", rate: l.taxRate.toString(), quantity: ZERO, value: ZERO, taxable: ZERO, igst: ZERO, cgst: ZERO, sgst: ZERO };
    row.quantity = row.quantity.add(l.quantity);
    row.value = row.value.add(l.lineTotal);
    row.taxable = row.taxable.add(l.taxableAmount);
    row.igst = row.igst.add(l.igstAmount);
    row.cgst = row.cgst.add(l.cgstAmount);
    row.sgst = row.sgst.add(l.sgstAmount);
    hsn.set(key, row);
  }

  const numbers = invoices.map((i) => i.number!).sort();
  return {
    gstin: q.gstin,
    state: GST_STATES[sellerState],
    period: { from: q.from, to: q.to },
    b2b,
    b2cl,
    b2cs: [...b2csMap.values()].map((r) => ({ ...r, taxable: f(r.taxable), igst: f(r.igst), cgst: f(r.cgst), sgst: f(r.sgst) })),
    creditDebitNotes: cdn,
    nilExemptNonGst: { nilRated: f(nil.nilRated), exempt: f(nil.exempt), nonGst: f(nil.nonGst) },
    hsnSummary: [...hsn.values()].map((r) => ({ ...r, quantity: r.quantity.toString(), value: f(r.value), taxable: f(r.taxable), igst: f(r.igst), cgst: f(r.cgst), sgst: f(r.sgst) })),
    documents: { invoices: { from: numbers[0] ?? null, to: numbers.at(-1) ?? null, total: invoices.length, cancelled: invoices.length - live.length } },
    warnings: [
      ...b2b.filter((x) => !x.gstinValid).map((x) => `Invoice ${x.invoiceNumber}: customer GSTIN ${x.customerGstin} fails validation`),
      ...([...hsn.keys()].some((k) => k.startsWith("MISSING")) ? ["Some invoice lines have no HSN/SAC code"] : []),
    ],
    disclaimer: "Prepared from posted documents for review. Not filed with the GST portal.",
  };
}

/** GSTR-3B style summary: outward tax liability and input tax credit from posted bills. */
export async function gstr3b(ctx: AccessContext, companyId: string, query: unknown) {
  const q = rangeSchema.parse(query);
  const company = await registration(ctx, companyId, q.gstin);
  const branchIds = company.branches.filter((b) => (b.gstin ?? company.gstin) === q.gstin).map((b) => b.id);
  const [invoiceLines, noteLines, billLines] = await Promise.all([
    prisma.salesInvoiceLine.findMany({ where: { invoice: { companyId, sellerGstin: q.gstin, status: FinanceDocStatus.POSTED, invoiceDate: { gte: q.from, lte: q.to } } } }),
    prisma.creditNoteLine.findMany({ where: { creditNote: { companyId, status: FinanceDocStatus.POSTED, noteDate: { gte: q.from, lte: q.to }, invoice: { sellerGstin: q.gstin } } } }),
    prisma.vendorBillLine.findMany({ where: { bill: { companyId, branchId: { in: branchIds }, status: FinanceDocStatus.POSTED, billDate: { gte: q.from, lte: q.to } } } }),
  ]);
  const sum = (rows: { taxableAmount: unknown; igstAmount: unknown; cgstAmount: unknown; sgstAmount: unknown }[], sign = 1) =>
    rows.reduce(
      (t, r) => ({
        taxable: t.taxable.add(dec(r.taxableAmount as Decimal).mul(sign)),
        igst: t.igst.add(dec(r.igstAmount as Decimal).mul(sign)),
        cgst: t.cgst.add(dec(r.cgstAmount as Decimal).mul(sign)),
        sgst: t.sgst.add(dec(r.sgstAmount as Decimal).mul(sign)),
      }),
      { taxable: ZERO, igst: ZERO, cgst: ZERO, sgst: ZERO },
    );
  const taxable = <T extends { taxKind: string }>(rows: T[]) => rows.filter((r) => r.taxKind === "TAXABLE");
  const exemptish = <T extends { taxKind: string }>(rows: T[]) => rows.filter((r) => r.taxKind !== "TAXABLE" && r.taxKind !== "ZERO_RATED");
  const out = (() => {
    const a = sum(taxable(invoiceLines));
    const b = sum(taxable(noteLines), -1);
    return { taxable: a.taxable.add(b.taxable), igst: a.igst.add(b.igst), cgst: a.cgst.add(b.cgst), sgst: a.sgst.add(b.sgst) };
  })();
  const nil = sum(exemptish(invoiceLines));
  const itc = sum(billLines);
  const fmt = (t: { taxable: Decimal; igst: Decimal; cgst: Decimal; sgst: Decimal }) => ({ taxable: f(t.taxable), igst: f(t.igst), cgst: f(t.cgst), sgst: f(t.sgst) });
  return {
    gstin: q.gstin,
    period: { from: q.from, to: q.to },
    "3.1(a) outward taxable supplies (net of credit notes)": fmt(out),
    "3.1(c) nil rated / exempt": { taxable: f(nil.taxable) },
    "4(A)(5) all other ITC (from posted vendor bills)": fmt(itc),
    netTaxBeforeSetOff: { igst: f(out.igst.sub(itc.igst)), cgst: f(out.cgst.sub(itc.cgst)), sgst: f(out.sgst.sub(itc.sgst)) },
    disclaimer: "Summary for review. ITC eligibility (blocked credits, reversals, GSTR-2B matching) must be checked before filing; nothing is filed.",
  };
}
