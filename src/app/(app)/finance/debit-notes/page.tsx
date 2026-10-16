import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listDebitNotes } from "@/features/finance/payables";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function DebitNotesPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Finance", "Debit notes"]}
      title="Debit notes"
      subtitle="Reductions against posted vendor bills (returns, short supply, price corrections). Raise one from the bill."
    />
  );
  if (!can(ctx, "vendor_bill.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view debit notes.</p></div>;
  }
  const page = await listDebitNotes(ctx, listParams(params, ["status", "vendorId", "billId"]));

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number, reason…"
            filters={[{ name: "status", label: "Status", options: ["DRAFT", "POSTED", "CANCELLED"].map((v) => ({ value: v, label: v })) }]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Debit note" },
              { key: "bill", label: "Bill" },
              { key: "vendor", label: "Vendor" },
              { key: "date", label: "Date" },
              { key: "total", label: "Total" },
              { key: "applied", label: "Applied" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") ? "No debit notes match your search." : "No debit notes yet."}
          >
            {page.items.length
              ? page.items.map((n) => (
                  <RecordsTableRow key={n.id}>
                    <RecordsTableCell>
                      <Link href={`/finance/debit-notes/${n.id}`} className="font-medium text-primary hover:underline">{n.number ?? "Draft"}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>
                      <Link href={`/purchasing/bills/${n.bill.id}`} className="text-primary hover:underline">{n.bill.number}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{n.vendor.name}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(n.noteDate)}</RecordsTableCell>
                    <RecordsTableCell>{formatMoney(n.grandTotal)}</RecordsTableCell>
                    <RecordsTableCell>{formatMoney(n.appliedAmount)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={n.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/finance/debit-notes" />
        </CardContent>
      </Card>
    </div>
  );
}
