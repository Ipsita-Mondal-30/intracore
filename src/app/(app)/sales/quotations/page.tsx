import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listQuotations } from "@/features/sales/quotations";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

const STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED", "SUPERSEDED"];

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function QuotationsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const page = await listQuotations(ctx, listParams(params, ["status"]));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Sales", "Quotations"]}
        title="Quotations"
        subtitle="Price offers to customers. Accepted quotations convert into sales orders."
        actions={
          can(ctx, "quotation.create") ? (
            <Link href="/sales/quotations/new" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90">
              New quotation
            </Link>
          ) : null
        }
      />

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number, notes…"
            filters={[{ name: "status", label: "Status", options: STATUSES.map((v) => ({ value: v, label: humanize(v) })) }]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Number" },
              { key: "customer", label: "Customer" },
              { key: "company", label: "Company" },
              { key: "issued", label: "Issued" },
              { key: "valid", label: "Valid until" },
              { key: "total", label: "Total" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") || param(params, "status") ? "No quotations match your filters." : "No quotations yet."}
          >
            {page.items.length
              ? page.items.map((q) => (
                  <RecordsTableRow key={q.id}>
                    <RecordsTableCell>
                      <Link href={`/sales/quotations/${q.id}`} className="font-medium text-primary hover:underline">
                        {q.number}{q.revision > 1 ? ` R${q.revision}` : ""}
                      </Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{q.customer.name}</RecordsTableCell>
                    <RecordsTableCell>{q.company.code}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(q.issueDate)}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(q.validUntil)}</RecordsTableCell>
                    <RecordsTableCell>{formatMoney(q.grandTotal, q.currency)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={q.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/sales/quotations" />
        </CardContent>
      </Card>
    </div>
  );
}
