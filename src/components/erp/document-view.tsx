import { prisma } from "@/lib/db/prisma";
import type { AccessContext } from "@/lib/access";
import { can } from "@/lib/access";
import { formatDateTime, formatMoney, formatQty, humanize } from "@/components/erp/format";

type Amount = { toString(): string };
type Line = {
  id: string;
  description: string;
  quantity: Amount;
  unitPrice: Amount;
  discountPercent: Amount;
  taxRate: Amount;
  taxableAmount: Amount;
  cgstAmount: Amount;
  sgstAmount: Amount;
  igstAmount: Amount;
  lineTotal: Amount;
  product?: { sku: string; hsnCode?: string | null } | null;
  uom?: { code: string } | null;
  deliveredQty?: Amount;
  receivedQty?: Amount;
};

export function DocumentLines({ lines, currency, progressLabel }: { lines: Line[]; currency: string; progressLabel?: "Delivered" | "Received" }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
          <tr className="border-b border-[var(--ic-border)]">
            <th className="py-2 pr-2">Item</th>
            <th className="py-2 pr-2 text-right">Qty</th>
            {progressLabel ? <th className="py-2 pr-2 text-right">{progressLabel}</th> : null}
            <th className="py-2 pr-2 text-right">Rate</th>
            <th className="py-2 pr-2 text-right">Disc %</th>
            <th className="py-2 pr-2 text-right">Taxable</th>
            <th className="py-2 pr-2 text-right">GST</th>
            <th className="py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const progress = progressLabel === "Delivered" ? line.deliveredQty : line.receivedQty;
            const gst = Number(line.cgstAmount.toString()) + Number(line.sgstAmount.toString()) + Number(line.igstAmount.toString());
            return (
              <tr key={line.id} className="border-b border-[var(--ic-border)] last:border-0">
                <td className="py-2 pr-2">
                  <p className="font-medium">{line.description}</p>
                  <p className="text-2xs text-subtle">
                    {line.product?.sku}
                    {line.product?.hsnCode ? ` · HSN ${line.product.hsnCode}` : ""}
                  </p>
                </td>
                <td className="py-2 pr-2 text-right">
                  {formatQty(line.quantity)} {line.uom?.code ?? ""}
                </td>
                {progressLabel ? <td className="py-2 pr-2 text-right">{formatQty(progress ?? 0)}</td> : null}
                <td className="py-2 pr-2 text-right">{formatMoney(line.unitPrice, currency)}</td>
                <td className="py-2 pr-2 text-right">{formatQty(line.discountPercent)}</td>
                <td className="py-2 pr-2 text-right">{formatMoney(line.taxableAmount, currency)}</td>
                <td className="py-2 pr-2 text-right">
                  {formatMoney(gst, currency)}
                  <span className="block text-2xs text-subtle">
                    {Number(line.igstAmount.toString()) > 0 ? `IGST ${formatQty(line.taxRate)}%` : `CGST+SGST ${formatQty(line.taxRate)}%`}
                  </span>
                </td>
                <td className="py-2 text-right font-medium">{formatMoney(line.lineTotal, currency)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DocumentTotals({
  doc,
  currency,
}: {
  doc: { subtotal: Amount; discountTotal: Amount; taxableTotal: Amount; taxTotal: Amount; grandTotal: Amount };
  currency: string;
}) {
  const rows: [string, Amount][] = [
    ["Subtotal", doc.subtotal],
    ["Discount", doc.discountTotal],
    ["Taxable value", doc.taxableTotal],
    ["GST", doc.taxTotal],
  ];
  return (
    <dl className="ml-auto mt-4 w-full max-w-xs space-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between text-muted">
          <dt>{label}</dt>
          <dd>{formatMoney(value, currency)}</dd>
        </div>
      ))}
      <div className="flex justify-between border-t border-[var(--ic-border)] pt-2 text-base font-semibold">
        <dt>Grand total</dt>
        <dd>{formatMoney(doc.grandTotal, currency)}</dd>
      </div>
    </dl>
  );
}

/** Status and change history for one record, from the audit trail. */
export async function AuditTrail({ ctx, entity, entityId }: { ctx: AccessContext; entity: string; entityId: string }) {
  // Entities whose view permission lives under another module.
  const viewPermission =
    ({
      stock_entry: "inventory.view",
      warehouse: "inventory.view",
      sales_invoice: "invoice.view",
      credit_note: "invoice.view",
      payment_receipt: "receipt.view",
      vendor_payment: "payment.view",
      debit_note: "vendor_bill.view",
      expense_claim: "expense.view",
      journal_entry: "finance.view",
    } as Record<string, string>)[entity] ?? `${entity}.view`;
  if (!can(ctx, "audit.view") && !can(ctx, viewPermission)) return null;
  const logs = await prisma.auditLog.findMany({
    where: { organizationId: ctx.organizationId, entity, entityId },
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (logs.length === 0) return <p className="text-sm text-muted">No history yet.</p>;
  return (
    <ol className="space-y-2 text-sm">
      {logs.map((log) => {
        const prev = log.previous as { status?: string } | null;
        const next = log.next as { status?: string; reason?: string; note?: string } | null;
        return (
          <li key={log.id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-2xs text-subtle">{formatDateTime(log.createdAt)}</span>
            <span className="font-medium">{humanize(log.action.split(".").pop() ?? log.action)}</span>
            {prev?.status && next?.status ? (
              <span className="text-muted">
                {humanize(prev.status)} → {humanize(next.status)}
              </span>
            ) : null}
            {next?.reason || next?.note ? <span className="text-muted">“{next.reason ?? next.note}”</span> : null}
            <span className="text-2xs text-subtle">by {log.user?.name ?? log.user?.email ?? "system"}</span>
          </li>
        );
      })}
    </ol>
  );
}
