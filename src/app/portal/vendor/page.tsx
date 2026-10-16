import Link from "next/link";
import { listBills, listGoodsReceipts, listPayments, listPurchaseOrders } from "@/features/portal/vendor";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, formatQty, humanize } from "@/components/erp/format";
import { pagePortal, PortalHeader, Section } from "@/app/portal/_components/portal-page";
import { vendorLinks } from "./nav";

const BILL_STATE: Record<string, string> = { DRAFT: "Under review", POSTED: "Accepted", CANCELLED: "Cancelled" };

export default async function VendorPortal() {
  const p = await pagePortal("VENDOR");
  const page = { pageSize: 50 };
  const [pos, receipts, bills, payments] = await Promise.all([listPurchaseOrders(p, page), listGoodsReceipts(p, page), listBills(p, page), listPayments(p, page)]);
  return (
    <div>
      <PortalHeader title="Supplier portal" organization={p.organizationName} links={vendorLinks} />
      <Section title="Purchase orders">
        <RecordsTable columns={[{ key: "n", label: "PO" }, { key: "s", label: "Status" }, { key: "d", label: "Date" }, { key: "e", label: "Expected" }, { key: "t", label: "Total" }]} empty="No purchase orders.">
          {pos.items.length
            ? pos.items.map((o) => (
                <RecordsTableRow key={o.id}>
                  <RecordsTableCell><Link className="font-medium text-primary hover:underline" href={`/portal/vendor/purchase-orders/${o.id}`}>{o.number}</Link></RecordsTableCell>
                  <RecordsTableCell><StatusBadge status={o.status} /></RecordsTableCell>
                  <RecordsTableCell>{formatDate(o.orderDate)}</RecordsTableCell>
                  <RecordsTableCell>{formatDate(o.expectedDate)}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(o.grandTotal, o.currency)}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      <Section title="Goods received">
        <RecordsTable columns={[{ key: "n", label: "Receipt" }, { key: "t", label: "Type" }, { key: "po", label: "PO" }, { key: "d", label: "Date" }, { key: "l", label: "Items" }]} empty="Nothing received yet.">
          {receipts.items.length
            ? receipts.items.map((r) => (
                <RecordsTableRow key={r.id}>
                  <RecordsTableCell>{r.number}</RecordsTableCell>
                  <RecordsTableCell>{humanize(r.type)}</RecordsTableCell>
                  <RecordsTableCell>{r.purchaseOrder?.number ?? "—"}</RecordsTableCell>
                  <RecordsTableCell>{formatDate(r.postedAt)}</RecordsTableCell>
                  <RecordsTableCell className="text-xs">{r.lines.map((l) => `${l.product.sku} × ${formatQty(l.quantity)} ${l.uom?.code ?? ""}`).join(", ")}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      <Section title="Your invoices">
        <RecordsTable columns={[{ key: "i", label: "Your invoice" }, { key: "n", label: "Our ref" }, { key: "s", label: "Status" }, { key: "d", label: "Due" }, { key: "t", label: "Total" }, { key: "o", label: "Outstanding" }]} empty="No invoices yet.">
          {bills.items.length
            ? bills.items.map((b) => (
                <RecordsTableRow key={b.id}>
                  <RecordsTableCell className="font-medium">{b.vendorInvoiceNumber}</RecordsTableCell>
                  <RecordsTableCell>{b.number}</RecordsTableCell>
                  <RecordsTableCell>{BILL_STATE[b.status] ?? b.status}</RecordsTableCell>
                  <RecordsTableCell>{formatDate(b.dueDate)}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(b.grandTotal, b.currency)}</RecordsTableCell>
                  <RecordsTableCell>{b.outstanding === null ? "—" : formatMoney(b.outstanding, b.currency)}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      <Section title="Payments">
        <RecordsTable columns={[{ key: "n", label: "Payment" }, { key: "d", label: "Date" }, { key: "m", label: "Method" }, { key: "a", label: "Amount" }, { key: "b", label: "Against" }]} empty="No payments yet.">
          {payments.items.length
            ? payments.items.map((pay) => (
                <RecordsTableRow key={pay.id}>
                  <RecordsTableCell>{pay.number}</RecordsTableCell>
                  <RecordsTableCell>{formatDate(pay.paymentDate)}</RecordsTableCell>
                  <RecordsTableCell>{humanize(pay.method)}{pay.reference ? ` · ${pay.reference}` : ""}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(pay.amount)}</RecordsTableCell>
                  <RecordsTableCell className="text-xs">{pay.allocations.map((a) => `${a.bill.vendorInvoiceNumber}: ${formatMoney(a.amount)}`).join(", ") || "—"}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
    </div>
  );
}
