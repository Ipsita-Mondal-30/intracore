import { StockEntryType, type Prisma, type StockEntry } from "@prisma/client";
import { dec } from "@/lib/money";
import { isJournaled, postJournal, reverseJournal, today, type MappingKey } from "@/features/finance/ledger";

type Db = Prisma.TransactionClient;

/**
 * Perpetual inventory: the inventory account moves by the value of the stock moves an
 * entry posted (moving-average cost); the other side depends on the document type.
 * Transfers inside a company net to zero and post nothing.
 */
const CONTRA: Record<StockEntryType, MappingKey | null> = {
  OPENING: "OPENING_BALANCE",
  RECEIPT: "STOCK_ADJUSTMENT",
  ISSUE: "STOCK_ADJUSTMENT",
  ADJUSTMENT: "STOCK_ADJUSTMENT",
  TRANSFER: null,
  GOODS_RECEIPT: "GRNI",
  DELIVERY: "COGS",
  SALES_RETURN: "COGS",
  PURCHASE_RETURN: "GRNI",
};

export async function postStockJournal(tx: Db, userId: string, entry: StockEntry) {
  const contra = CONTRA[entry.type];
  const date = today();
  if (!contra || !(await isJournaled(tx, entry.companyId, date))) return null;
  const moves = await tx.stockMove.aggregate({ where: { entryId: entry.id, isReversal: false }, _sum: { value: true } });
  const delta = dec(moves._sum.value);
  if (delta.isZero()) return null;
  return postJournal(tx, { organizationId: entry.organizationId, companyId: entry.companyId, userId }, {
    date,
    sourceType: "STOCK_ENTRY",
    sourceId: entry.id,
    memo: `${entry.type.replace(/_/g, " ").toLowerCase()} ${entry.number}`,
    // Inventory up = debit inventory; the contra takes the other side (normalised by sign).
    lines: [
      { account: "INVENTORY", debit: delta },
      { account: contra, credit: delta },
    ],
  });
}

/** Reverse the stock journal of a cancelled entry, if one was posted. */
export async function reverseStockJournal(tx: Db, userId: string, entry: StockEntry) {
  const journal = await tx.journalEntry.findUnique({
    where: { companyId_sourceType_sourceId_sourceEvent: { companyId: entry.companyId, sourceType: "STOCK_ENTRY", sourceId: entry.id, sourceEvent: "post" } },
  });
  if (!journal) return null;
  return reverseJournal(tx, { organizationId: entry.organizationId, companyId: entry.companyId, userId }, journal.id, today(), `Cancellation of ${entry.number}`);
}
