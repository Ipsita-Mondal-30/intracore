import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listInvoices } from "@/features/finance/receivables";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function InvoicesPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  if (!can(ctx, "invoice.view")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["Finance", "Invoices"]} title="Invoices" />
        <p className="text-sm text-muted">You don&apos;t have permission to view invoices.</p>
      </div>
    );
  }
  const page = await listInvoices(ctx, listParams(params, ["status", "outstanding", "customerId", "companyId"]));
  const now = new Date();

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Invoices"]}
        title="Invoices"
        subtitle="Sales invoices. Numbers are assigned when an invoice is posted."
        actions={
          can(ctx, "invoice.create") ? (
            <Link href="/finance/invoices/new" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90">New invoice</Link>
          ) : null
        }
      />

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number, GSTIN, notes…"
            filters={[
              { name: "status", label: "Status", options: ["DRAFT", "POSTED", "CANCELLED"].map((v) => ({ value: v, label: v })) },
              { name: "outstanding", label: "Outstanding", options: [{ value: "true", label: "Outstanding" }, { value: "overdue", label: "Overdue" }] },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Number" },
              { key: "customer", label: "Customer" },
              { key: "date", label: "Date" },
              { key: "due", label: "Due" },
              { key: "total", label: "Total", className: "text-right" },
              { key: "outstanding", label: "Outstanding", className: "text-right" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") || param(params, "status") || param(params, "outstanding") ? "No invoices match these filters." : "No invoices yet."}
          >
            {page.items.length
              ? page.items.map((inv) => {
                  const overdue = inv.status === "POSTED" && Number(inv.outstanding) > 0 && inv.dueDate < now;
                  return (
                    <RecordsTableRow key={inv.id}>
                      <RecordsTableCell>
                        <Link href={`/finance/invoices/${inv.id}`} className="font-medium text-primary hover:underline">{inv.number ?? "Draft"}</Link>
                      </RecordsTableCell>
                      <RecordsTableCell>{inv.customer.name}</RecordsTableCell>
                      <RecordsTableCell>{formatDate(inv.invoiceDate)}</RecordsTableCell>
                      <RecordsTableCell className={overdue ? "text-danger" : undefined}>{formatDate(inv.dueDate)}</RecordsTableCell>
                      <RecordsTableCell className="text-right">{formatMoney(inv.grandTotal, inv.currency)}</RecordsTableCell>
                      <RecordsTableCell className="text-right">{inv.status === "POSTED" ? formatMoney(inv.outstanding, inv.currency) : "—"}</RecordsTableCell>
                      <RecordsTableCell><StatusBadge status={inv.status} /></RecordsTableCell>
                    </RecordsTableRow>
                  );
                })
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/finance/invoices" />
        </CardContent>
      </Card>
    </div>
  );
}
