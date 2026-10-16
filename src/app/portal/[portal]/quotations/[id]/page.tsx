import { getQuotation } from "@/features/portal/customer";
import { DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate } from "@/components/erp/format";
import { orNotFound, pagePortal, PortalHeader, salesKind, Section } from "@/app/portal/_components/portal-page";
import { portalTitle, salesLinks } from "../../nav";

export default async function PortalQuotation({ params }: { params: Promise<{ portal: string; id: string }> }) {
  const { portal, id } = await params;
  const p = await pagePortal(salesKind(portal));
  const q = await orNotFound(getQuotation(p, id));
  return (
    <div>
      <PortalHeader title={portalTitle(portal)} organization={p.organizationName} links={salesLinks(portal)} />
      <Section title={`Quotation ${q.number}${q.revision > 1 ? ` (revision ${q.revision})` : ""}`}>
        <div className="mb-4 flex flex-wrap gap-4 text-sm">
          <StatusBadge status={q.status} />
          <span>Issued {formatDate(q.issueDate)}</span>
          <span>Valid until {formatDate(q.validUntil)}</span>
          <span>{q.company.name}</span>
          {q.salesOrder ? <span>Order {q.salesOrder.number}</span> : null}
        </div>
        <DocumentLines lines={q.lines} currency={q.currency} />
        <DocumentTotals doc={q} currency={q.currency} />
        {q.terms ? <p className="mt-4 whitespace-pre-wrap text-sm text-muted">{q.terms}</p> : null}
      </Section>
    </div>
  );
}
