import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { dec } from "@/lib/money";
import { listCreditNotes } from "@/features/finance/receivables";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CreditNotesPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  if (!can(ctx, "invoice.view")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["Finance", "Credit notes"]} title="Credit notes" />
        <p className="text-sm text-muted">You don&apos;t have permission to view credit notes.</p>
      </div>
    );
  }
  const page = await listCreditNotes(ctx, listParams(params, ["status", "customerId", "invoiceId"]));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Credit notes"]}
        title="Credit notes"
        subtitle="Raised from a posted invoice (open the invoice and use “Credit note”)."
      />
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number, reason…"
            filters={[{ name: "status", label: "Status", options: ["DRAFT", "POSTED", "CANCELLED"].map((v) => ({ value: v, label: v })) }]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Number" },
              { key: "customer", label: "Customer" },
              { key: "invoice", label: "Invoice" },
              { key: "date", label: "Date" },
              { key: "total", label: "Total", className: "text-right" },
              { key: "unapplied", label: "Unapplied", className: "text-right" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") || param(params, "status") ? "No credit notes match these filters." : "No credit notes yet."}
          >
            {page.items.length
              ? page.items.map((n) => (
                  <RecordsTableRow key={n.id}>
                    <RecordsTableCell>
                      <Link href={`/finance/credit-notes/${n.id}`} className="font-medium text-primary hover:underline">{n.number ?? "Draft"}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{n.customer.name}</RecordsTableCell>
                    <RecordsTableCell>
                      <Link href={`/finance/invoices/${n.invoice.id}`} className="text-primary hover:underline">{n.invoice.number ?? "Draft"}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{formatDate(n.noteDate)}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatMoney(n.grandTotal)}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{n.status === "POSTED" ? formatMoney(dec(n.grandTotal).sub(n.appliedAmount).toString()) : "—"}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={n.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/finance/credit-notes" />
        </CardContent>
      </Card>
    </div>
  );
}
