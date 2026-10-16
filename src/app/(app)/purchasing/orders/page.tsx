import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listPurchaseOrders } from "@/features/purchasing/purchase-orders";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED", "CLOSED"];

export default async function PurchaseOrdersPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const page = await listPurchaseOrders(ctx, listParams(params, ["status", "vendorId", "companyId"]));
  const filtered = Boolean(param(params, "q") || param(params, "status") || param(params, "vendorId"));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Purchasing", "Purchase orders"]}
        title="Purchase orders"
        subtitle="Orders placed with vendors. Stock arrives when goods are received against an approved order."
        actions={
          can(ctx, "purchase_order.create") ? (
            <Link href="/purchasing/orders/new" className="text-sm font-medium text-primary hover:underline">New purchase order</Link>
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
              { key: "vendor", label: "Vendor" },
              { key: "warehouse", label: "Warehouse" },
              { key: "orderDate", label: "Order date" },
              { key: "expected", label: "Expected" },
              { key: "total", label: "Total", className: "text-right" },
              { key: "status", label: "Status" },
            ]}
            empty={filtered ? "No purchase orders match your filters." : "No purchase orders yet."}
          >
            {page.items.length
              ? page.items.map((o) => (
                  <RecordsTableRow key={o.id}>
                    <RecordsTableCell>
                      <Link href={`/purchasing/orders/${o.id}`} className="font-medium text-primary hover:underline">{o.number}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>
                      <Link href={`/purchasing/vendors/${o.vendor.id}`} className="hover:underline">{o.vendor.name}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{o.warehouse.code}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(o.orderDate)}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(o.expectedDate)}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatMoney(o.grandTotal, o.currency)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={o.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/purchasing/orders" />
        </CardContent>
      </Card>
    </div>
  );
}
