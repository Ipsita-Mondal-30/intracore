import type { Prisma } from "@prisma/client";

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
};

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
) {
  const prefix = DOCUMENT_PREFIXES[documentType];
  if (!prefix) throw new Error(`Unknown document type: ${documentType}`);
  const [row] = await tx.$queryRaw<{ n: number; prefix: string; padding: number }[]>`
    INSERT INTO "number_sequences" ("id", "organizationId", "companyId", "documentType", "prefix", "nextNumber", "updatedAt")
    VALUES (gen_random_uuid()::text, ${organizationId}, ${companyId}, ${documentType}, ${prefix}, 2, now())
    ON CONFLICT ("companyId", "documentType")
    DO UPDATE SET "nextNumber" = "number_sequences"."nextNumber" + 1, "updatedAt" = now()
    RETURNING "nextNumber" - 1 AS n, "prefix", "padding"`;
  return `${row.prefix}${String(row.n).padStart(row.padding, "0")}`;
}
