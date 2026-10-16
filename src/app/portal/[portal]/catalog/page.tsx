import { notFound } from "next/navigation";
import { listCatalog, listOrderRequests } from "@/features/portal/dealer";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney } from "@/components/erp/format";
import { pagePortal, PortalHeader, Section } from "@/app/portal/_components/portal-page";
import { portalTitle, salesLinks } from "../nav";
import { OrderRequestForm } from "./order-request-form";

export default async function DealerCatalog({ params }: { params: Promise<{ portal: string }> }) {
  const { portal } = await params;
  if (portal !== "dealer") notFound();
  const p = await pagePortal("DEALER");
  const [catalog, requests] = await Promise.all([listCatalog(p), listOrderRequests(p)]);
  return (
    <div>
      <PortalHeader title={portalTitle(portal)} organization={p.organizationName} links={salesLinks(portal)} />
      <Section title="Authorized products and your prices">
        <RecordsTable columns={[{ key: "s", label: "SKU" }, { key: "n", label: "Product" }, { key: "u", label: "Unit" }, { key: "t", label: "GST" }, { key: "p", label: "Your price" }]} empty="No authorized products yet.">
          {catalog.length
            ? catalog.map((c) => (
                <RecordsTableRow key={c.product.id}>
                  <RecordsTableCell>{c.product.sku}</RecordsTableCell>
                  <RecordsTableCell>{c.product.name}</RecordsTableCell>
                  <RecordsTableCell>{c.product.uom.code}</RecordsTableCell>
                  <RecordsTableCell>{c.product.taxRate?.name ?? "—"}</RecordsTableCell>
                  <RecordsTableCell className="font-medium">{formatMoney(c.unitPrice)}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      {catalog.length ? (
        <Section title="Request an order">
          <p className="mb-3 text-sm text-muted">Your request is priced at your rates and reviewed by our sales team, who confirm it as a quotation.</p>
          <OrderRequestForm products={catalog.map((c) => ({ id: c.product.id, label: `${c.product.sku} · ${c.product.name} (${c.unitPrice.toString()} / ${c.product.uom.code})` }))} />
        </Section>
      ) : null}
      <Section title="Your requests">
        <RecordsTable columns={[{ key: "n", label: "Reference" }, { key: "s", label: "Status" }, { key: "d", label: "Date" }, { key: "t", label: "Total" }, { key: "o", label: "Order" }]} empty="No requests yet.">
          {requests.length
            ? requests.map((r) => (
                <RecordsTableRow key={r.id}>
                  <RecordsTableCell className="font-medium">{r.number}</RecordsTableCell>
                  <RecordsTableCell><StatusBadge status={r.status === "DRAFT" || r.status === "PENDING_APPROVAL" ? "PENDING" : r.status} /></RecordsTableCell>
                  <RecordsTableCell>{formatDate(r.issueDate)}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(r.grandTotal, r.currency)}</RecordsTableCell>
                  <RecordsTableCell>{r.salesOrder ? r.salesOrder.number : "—"}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
    </div>
  );
}
