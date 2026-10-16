import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listVendorBills } from "@/features/purchasing/bills";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUSES = ["DRAFT", "POSTED", "CANCELLED"];

export default async function VendorBillsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const page = await listVendorBills(ctx, listParams(params, ["status", "vendorId", "purchaseOrderId"]));
  const filtered = Boolean(param(params, "q") || param(params, "status") || param(params, "vendorId") || param(params, "purchaseOrderId"));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Purchasing", "Vendor bills"]}
        title="Vendor bills"
        subtitle="Supplier invoices. Posting checks billed quantities against what was received."
        actions={
          can(ctx, "vendor_bill.create") ? (
            <Link href="/purchasing/bills/new" className="text-sm font-medium text-primary hover:underline">New bill</Link>
          ) : null
        }
      />

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number, vendor invoice no., notes…"
            filters={[{ name: "status", label: "Status", options: STATUSES.map((v) => ({ value: v, label: humanize(v) })) }]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Number" },
              { key: "invoice", label: "Vendor invoice no." },
              { key: "vendor", label: "Vendor" },
              { key: "po", label: "PO" },
              { key: "billDate", label: "Bill date" },
              { key: "dueDate", label: "Due date" },
              { key: "total", label: "Total", className: "text-right" },
              { key: "status", label: "Status" },
            ]}
            empty={filtered ? "No bills match your filters." : "No vendor bills yet."}
          >
            {page.items.length
              ? page.items.map((b) => (
                  <RecordsTableRow key={b.id}>
                    <RecordsTableCell>
                      <Link href={`/purchasing/bills/${b.id}`} className="font-medium text-primary hover:underline">{b.number}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{b.vendorInvoiceNumber}</RecordsTableCell>
                    <RecordsTableCell>
                      <Link href={`/purchasing/vendors/${b.vendor.id}`} className="hover:underline">{b.vendor.name}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>
                      {b.purchaseOrder ? <Link href={`/purchasing/orders/${b.purchaseOrder.id}`} className="hover:underline">{b.purchaseOrder.number}</Link> : "—"}
                    </RecordsTableCell>
                    <RecordsTableCell>{formatDate(b.billDate)}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(b.dueDate)}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatMoney(b.grandTotal, b.currency)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={b.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/purchasing/bills" />
        </CardContent>
      </Card>
    </div>
  );
}
