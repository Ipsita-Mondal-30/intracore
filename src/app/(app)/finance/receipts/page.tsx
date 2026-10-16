import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { dec } from "@/lib/money";
import { listReceipts } from "@/features/finance/receivables";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ReceiptsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  if (!can(ctx, "receipt.view")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["Finance", "Receipts"]} title="Receipts" />
        <p className="text-sm text-muted">You don&apos;t have permission to view receipts.</p>
      </div>
    );
  }
  const page = await listReceipts(ctx, listParams(params, ["status", "customerId"]));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Receipts"]}
        title="Receipts"
        subtitle="Money received from customers."
        actions={
          can(ctx, "receipt.create") ? (
            <Link href="/finance/receipts/new" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90">Record receipt</Link>
          ) : null
        }
      />
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number, reference, notes…"
            filters={[{ name: "status", label: "Status", options: ["POSTED", "CANCELLED"].map((v) => ({ value: v, label: v })) }]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Number" },
              { key: "customer", label: "Customer" },
              { key: "date", label: "Date" },
              { key: "account", label: "Into / method" },
              { key: "amount", label: "Amount", className: "text-right" },
              { key: "unallocated", label: "Unallocated", className: "text-right" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") || param(params, "status") ? "No receipts match these filters." : "No receipts yet."}
          >
            {page.items.length
              ? page.items.map((r) => (
                  <RecordsTableRow key={r.id}>
                    <RecordsTableCell>
                      <Link href={`/finance/receipts/${r.id}`} className="font-medium text-primary hover:underline">{r.number ?? "—"}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{r.customer.name}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(r.receiptDate)}</RecordsTableCell>
                    <RecordsTableCell>{r.bankAccount.name} · {humanize(r.method)}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatMoney(r.amount)}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{r.status === "POSTED" ? formatMoney(dec(r.amount).sub(r.allocatedAmount).toString()) : "—"}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={r.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/finance/receipts" />
        </CardContent>
      </Card>
    </div>
  );
}
