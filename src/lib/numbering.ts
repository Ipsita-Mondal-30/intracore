import type { Prisma } from "@prisma/client";
import { companySettings } from "@/lib/settings";

/** Default prefixes per document type; companies can change them via number-sequences. */
export const DOCUMENT_PREFIXES: Record<string, string> = {
  quotation: "QT-",
  sales_order: "SO-",
  purchase_order: "PO-",
  vendor_bill: "BILL-",
  goods_receipt: "GRN-",
  delivery: "DN-",
  stock_entry: "SE-",
  sales_return: "SR-",
  purchase_return: "PR-",
  // Finance documents restart every fiscal year: GST invoice numbers must be unique per
  // financial year and at most 16 characters ("INV/26-27/00001" is 15).
  sales_invoice: "INV/{FY}/",
  credit_note: "CN/{FY}/",
  receipt: "RCT/{FY}/",
  vendor_payment: "PAY/{FY}/",
  debit_note: "DBN/{FY}/",
  journal: "JV/{FY}/",
  expense_claim: "EXP/{FY}/",
  transfer: "TRF/{FY}/",
  employee: "EMP-",
  ticket: "TKT-",
  service_contract: "AMC-",
  installation: "INS-",
  work_order: "WO-",
  nonconformance: "NCR-",
};

/** "26-27" for a date in the fiscal year starting in `startMonth` (1-12) of 2026. */
export function fiscalYearLabel(date: Date, startMonth = 4) {
  const year = date.getUTCMonth() + 1 >= startMonth ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  if (startMonth === 1) return String(year);
  return `${String(year % 100).padStart(2, "0")}-${String((year + 1) % 100).padStart(2, "0")}`;
}

/**
 * Next number for a company's document type, e.g. "QT-00042". Must run inside the
 * transaction that creates the document: the sequence row stays locked until commit
 * and a rollback also rolls back the increment, so numbers are gapless.
 */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  organizationId: string,
  companyId: string,
  documentType: string,
  date: Date = new Date(),
) {
  const fallback = DOCUMENT_PREFIXES[documentType];
  if (!fallback) throw new Error(`Unknown document type: ${documentType}`);
  // A "{FY}" prefix keeps a separate counter per fiscal year.
  const base = await tx.numberSequence.findUnique({ where: { companyId_documentType: { companyId, documentType } } });
  const template = base?.prefix ?? fallback;
  let key = documentType;
  let label = "";
  if (template.includes("{FY}")) {
    const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { settings: true } });
    const startMonth = companySettings(company.settings).finance.fiscalYearStartMonth;
    label = fiscalYearLabel(date, startMonth);
    key = `${documentType}@${label}`;
  }
  const [row] = await tx.$queryRaw<{ n: number; padding: number }[]>`
    INSERT INTO "number_sequences" ("id", "organizationId", "companyId", "documentType", "prefix", "padding", "nextNumber", "updatedAt")
    VALUES (gen_random_uuid()::text, ${organizationId}, ${companyId}, ${key}, ${template}, ${base?.padding ?? 5}, 2, now())
    ON CONFLICT ("companyId", "documentType")
    DO UPDATE SET "nextNumber" = "number_sequences"."nextNumber" + 1, "updatedAt" = now()
    RETURNING "nextNumber" - 1 AS n, "padding"`;
  return `${template.replace("{FY}", label)}${String(row.n).padStart(row.padding, "0")}`;
}
