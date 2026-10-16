import Link from "next/link";
import { listInvoices, listOrders, listPayments, listQuotations } from "@/features/portal/customer";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";
import { pagePortal, PortalHeader, salesKind, Section } from "@/app/portal/_components/portal-page";
import { portalTitle, salesLinks } from "./nav";

type Props = { params: Promise<{ portal: string }> };

export default async function SalesPortalHome({ params }: Props) {
  const { portal } = await params;
  const p = await pagePortal(salesKind(portal));
  const base = `/portal/${portal}`;
  const page = { pageSize: 50 };
  const [invoices, quotations, orders, payments] = await Promise.all([listInvoices(p, page), listQuotations(p, page), listOrders(p, page), listPayments(p, page)]);

  return (
    <div>
      <PortalHeader title={portalTitle(portal)} organization={p.organizationName} links={salesLinks(portal)} />
      <Section title="Invoices">
        <RecordsTable columns={[{ key: "n", label: "Invoice" }, { key: "d", label: "Date" }, { key: "due", label: "Due" }, { key: "t", label: "Total" }, { key: "o", label: "Outstanding" }]} empty="No invoices.">
          {invoices.items.length
            ? invoices.items.map((i) => (
                <RecordsTableRow key={i.id}>
                  <RecordsTableCell><Link className="font-medium text-primary hover:underline" href={`${base}/invoices/${i.id}`}>{i.number}</Link></RecordsTableCell>
                  <RecordsTableCell>{formatDate(i.invoiceDate)}</RecordsTableCell>
                  <RecordsTableCell>{formatDate(i.dueDate)}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(i.grandTotal, i.currency)}</RecordsTableCell>
                  <RecordsTableCell className="font-medium">{formatMoney(i.outstanding, i.currency)}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      <Section title="Quotations">
        <RecordsTable columns={[{ key: "n", label: "Quotation" }, { key: "s", label: "Status" }, { key: "d", label: "Issued" }, { key: "v", label: "Valid until" }, { key: "t", label: "Total" }]} empty="No quotations.">
          {quotations.items.length
            ? quotations.items.map((q) => (
                <RecordsTableRow key={q.id}>
                  <RecordsTableCell><Link className="font-medium text-primary hover:underline" href={`${base}/quotations/${q.id}`}>{q.number}{q.revision > 1 ? ` r${q.revision}` : ""}</Link></RecordsTableCell>
                  <RecordsTableCell><StatusBadge status={q.status} /></RecordsTableCell>
                  <RecordsTableCell>{formatDate(q.issueDate)}</RecordsTableCell>
                  <RecordsTableCell>{formatDate(q.validUntil)}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(q.grandTotal, q.currency)}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      <Section title="Orders">
        <RecordsTable columns={[{ key: "n", label: "Order" }, { key: "s", label: "Status" }, { key: "d", label: "Date" }, { key: "po", label: "Your PO" }, { key: "t", label: "Total" }]} empty="No orders.">
          {orders.items.length
            ? orders.items.map((o) => (
                <RecordsTableRow key={o.id}>
                  <RecordsTableCell><Link className="font-medium text-primary hover:underline" href={`${base}/orders/${o.id}`}>{o.number}</Link></RecordsTableCell>
                  <RecordsTableCell><StatusBadge status={o.status} /></RecordsTableCell>
                  <RecordsTableCell>{formatDate(o.orderDate)}</RecordsTableCell>
                  <RecordsTableCell>{o.customerPoNumber ?? "—"}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(o.grandTotal, o.currency)}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      <Section title="Payments">
        <RecordsTable columns={[{ key: "n", label: "Receipt" }, { key: "d", label: "Date" }, { key: "m", label: "Method" }, { key: "a", label: "Amount" }, { key: "i", label: "Applied to" }]} empty="No payments.">
          {payments.items.length
            ? payments.items.map((r) => (
                <RecordsTableRow key={r.id}>
                  <RecordsTableCell>{r.number}</RecordsTableCell>
                  <RecordsTableCell>{formatDate(r.receiptDate)}</RecordsTableCell>
                  <RecordsTableCell>{humanize(r.method)}{r.reference ? ` · ${r.reference}` : ""}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(r.amount)}</RecordsTableCell>
                  <RecordsTableCell className="text-xs">{r.allocations.map((a) => `${a.invoice.number}: ${formatMoney(a.amount)}`).join(", ") || "—"}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
    </div>
  );
}
