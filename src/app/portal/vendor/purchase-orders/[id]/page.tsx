import { getPurchaseOrder } from "@/features/portal/vendor";
import { DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate } from "@/components/erp/format";
import { orNotFound, pagePortal, PortalHeader, Section } from "@/app/portal/_components/portal-page";
import { vendorLinks } from "../../nav";
import { SubmitInvoiceForm } from "./submit-invoice-form";

export default async function VendorPurchaseOrder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await pagePortal("VENDOR");
  const po = await orNotFound(getPurchaseOrder(p, id));
  return (
    <div>
      <PortalHeader title="Supplier portal" organization={p.organizationName} links={vendorLinks} />
      <Section title={`Purchase order ${po.number}`}>
        <div className="mb-4 flex flex-wrap gap-4 text-sm">
          <StatusBadge status={po.status} />
          <span>Ordered {formatDate(po.orderDate)}</span>
          <span>Expected {formatDate(po.expectedDate)}</span>
          <span>Deliver to {po.company.name} · {po.warehouse.name}</span>
        </div>
        <DocumentLines lines={po.lines} currency={po.currency} progressLabel="Received" />
        <DocumentTotals doc={po} currency={po.currency} />
      </Section>
      {po.status !== "CANCELLED" ? (
        <Section title="Submit an invoice">
          <p className="mb-3 text-sm text-muted">Your invoice is recorded for review; it is matched against goods received before payment.</p>
          <SubmitInvoiceForm purchaseOrderId={po.id} lines={po.lines.map((l) => ({ id: l.id, label: `${l.product.sku} · ${l.description}`, open: Math.max(0, Number(l.receivedQty.toString()) - Number(l.billedQty.toString())) }))} />
        </Section>
      ) : null}
    </div>
  );
}
