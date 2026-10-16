import { getInvoice } from "@/features/portal/customer";
import { DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { formatDate, formatMoney } from "@/components/erp/format";
import { orNotFound, pagePortal, PortalHeader, salesKind, Section } from "@/app/portal/_components/portal-page";
import { portalTitle, salesLinks } from "../../nav";

export default async function PortalInvoice({ params }: { params: Promise<{ portal: string; id: string }> }) {
  const { portal, id } = await params;
  const p = await pagePortal(salesKind(portal));
  const i = await orNotFound(getInvoice(p, id));
  return (
    <div>
      <PortalHeader title={portalTitle(portal)} organization={p.organizationName} links={salesLinks(portal)} />
      <Section title={`Invoice ${i.number}`}>
        <div className="mb-4 flex flex-wrap gap-4 text-sm">
          <span>Dated {formatDate(i.invoiceDate)}</span>
          <span>Due {formatDate(i.dueDate)}</span>
          {i.sellerGstin ? <span>Seller GSTIN {i.sellerGstin}</span> : null}
          <span className="font-semibold">Outstanding {formatMoney(i.outstanding, i.currency)}</span>
        </div>
        <DocumentLines lines={i.lines} currency={i.currency} />
        <DocumentTotals doc={i} currency={i.currency} />
        {i.allocations.length ? (
          <ul className="mt-4 text-sm text-muted">
            {i.allocations.map((a, n) => (
              <li key={n}>{a.receipt ? `Payment ${a.receipt.number ?? ""} on ${formatDate(a.receipt.receiptDate)}` : `Credit note ${a.creditNote?.number ?? ""}`}: {formatMoney(a.amount, i.currency)}</li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}
