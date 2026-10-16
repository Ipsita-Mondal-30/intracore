import Link from "next/link";
import { StockEntryStatus, StockEntryType } from "@prisma/client";
import { can, getAccessContext } from "@/lib/access";
import { listStockEntries } from "@/features/inventory/entries";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function StockEntriesPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const page = await listStockEntries(ctx, listParams(params, ["type", "status"]));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Inventory", "Stock entries"]}
        title="Stock entries"
        subtitle="Every stock movement: opening stock, receipts, issues, adjustments, transfers, deliveries and returns."
        actions={
          can(ctx, "inventory.create") ? (
            <Link href="/inventory/entries/new" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90">New entry</Link>
          ) : null
        }
      />

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number, reference, notes…"
            filters={[
              { name: "type", label: "Type", options: Object.values(StockEntryType).map((v) => ({ value: v, label: humanize(v) })) },
              { name: "status", label: "Status", options: Object.values(StockEntryStatus).map((v) => ({ value: v, label: humanize(v) })) },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Number" },
              { key: "type", label: "Type" },
              { key: "status", label: "Status" },
              { key: "warehouse", label: "Warehouse" },
              { key: "lines", label: "Lines", className: "text-right" },
              { key: "posted", label: "Posted" },
            ]}
            empty={param(params, "q") || param(params, "type") || param(params, "status") ? "No entries match these filters." : "No stock entries yet."}
          >
            {page.items.length
              ? page.items.map((e) => (
                  <RecordsTableRow key={e.id}>
                    <RecordsTableCell>
                      <Link href={`/inventory/entries/${e.id}`} className="font-medium text-primary hover:underline">{e.number}</Link>
                      {e.reference ? <span className="block text-2xs text-subtle">{e.reference}</span> : null}
                    </RecordsTableCell>
                    <RecordsTableCell>{humanize(e.type)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={e.status} /></RecordsTableCell>
                    <RecordsTableCell>{[e.sourceWarehouse?.code, e.targetWarehouse?.code].filter(Boolean).join(" → ") || "—"}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{e._count.lines}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(e.postedAt)}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/inventory/entries" />
        </CardContent>
      </Card>
    </div>
  );
}
