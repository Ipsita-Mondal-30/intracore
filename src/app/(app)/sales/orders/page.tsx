import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listSalesOrders } from "@/features/sales/orders";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUSES = ["DRAFT", "CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED", "CANCELLED"];

export default async function SalesOrdersPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const page = await listSalesOrders(ctx, listParams(params, ["status", "customerId"]));
  const filtered = Boolean(param(params, "q") || param(params, "status"));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Sales", "Orders"]}
        title="Sales orders"
        subtitle="Confirmed customer commitments. Create one directly or convert an accepted quotation."
        actions={
          can(ctx, "sales_order.create") ? (
            <Link href="/sales/orders/new" className="text-sm font-medium text-primary hover:underline">New order</Link>
          ) : null
        }
      />

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number, customer PO, notes…"
            filters={[{ name: "status", label: "Status", options: STATUSES.map((v) => ({ value: v, label: humanize(v) })) }]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Number" },
              { key: "customer", label: "Customer" },
              { key: "po", label: "Customer PO" },
              { key: "orderDate", label: "Order date" },
              { key: "expected", label: "Expected delivery" },
              { key: "total", label: "Total", className: "text-right" },
              { key: "status", label: "Status" },
            ]}
            empty={filtered ? "No orders match your filters." : "No sales orders yet."}
          >
            {page.items.length
              ? page.items.map((o) => (
                  <RecordsTableRow key={o.id}>
                    <RecordsTableCell>
                      <Link href={`/sales/orders/${o.id}`} className="font-medium text-primary hover:underline">{o.number}</Link>
                      <span className="ml-2 text-2xs text-subtle">{o.company.code}</span>
                    </RecordsTableCell>
                    <RecordsTableCell>
                      <Link href={`/crm/customers/${o.customer.id}`} className="hover:underline">{o.customer.name}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{o.customerPoNumber ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(o.orderDate)}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(o.expectedDeliveryDate)}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatMoney(o.grandTotal, o.currency)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={o.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/sales/orders" />
        </CardContent>
      </Card>
    </div>
  );
}
