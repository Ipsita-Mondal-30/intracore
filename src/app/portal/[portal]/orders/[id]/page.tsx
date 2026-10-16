import { getOrder } from "@/features/portal/customer";
import { DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate } from "@/components/erp/format";
import { orNotFound, pagePortal, PortalHeader, salesKind, Section } from "@/app/portal/_components/portal-page";
import { portalTitle, salesLinks } from "../../nav";

export default async function PortalOrder({ params }: { params: Promise<{ portal: string; id: string }> }) {
  const { portal, id } = await params;
  const p = await pagePortal(salesKind(portal));
  const o = await orNotFound(getOrder(p, id));
  return (
    <div>
      <PortalHeader title={portalTitle(portal)} organization={p.organizationName} links={salesLinks(portal)} />
      <Section title={`Order ${o.number}`}>
        <div className="mb-4 flex flex-wrap gap-4 text-sm">
          <StatusBadge status={o.status} />
          <span>Ordered {formatDate(o.orderDate)}</span>
          <span>Expected {formatDate(o.expectedDeliveryDate)}</span>
          {o.customerPoNumber ? <span>Your PO {o.customerPoNumber}</span> : null}
        </div>
        <DocumentLines lines={o.lines} currency={o.currency} progressLabel="Delivered" />
        <DocumentTotals doc={o} currency={o.currency} />
        {o.shippingAddress ? <p className="mt-4 whitespace-pre-wrap text-sm text-muted">Ship to: {o.shippingAddress}</p> : null}
      </Section>
    </div>
  );
}
