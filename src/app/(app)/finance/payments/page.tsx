import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listVendorPayments } from "@/features/finance/payables";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function VendorPaymentsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Finance", "Vendor payments"]}
      title="Vendor payments"
      subtitle="Money paid to vendors, settled against posted bills. Unallocated amounts are advances."
      actions={can(ctx, "payment.create") ? <Link href="/finance/payments/new" className="text-sm text-primary hover:underline">Record payment</Link> : null}
    />
  );
  if (!can(ctx, "payment.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view vendor payments.</p></div>;
  }
  const page = await listVendorPayments(ctx, listParams(params, ["status", "vendorId"]));

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number, reference…"
            filters={[{ name: "status", label: "Status", options: ["POSTED", "CANCELLED"].map((v) => ({ value: v, label: v })) }]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Payment" },
              { key: "vendor", label: "Vendor" },
              { key: "date", label: "Date" },
              { key: "bank", label: "Paid from" },
              { key: "amount", label: "Amount" },
              { key: "unallocated", label: "Unallocated" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") ? "No payments match your search." : "No vendor payments yet."}
          >
            {page.items.length
              ? page.items.map((p) => (
                  <RecordsTableRow key={p.id}>
                    <RecordsTableCell>
                      <Link href={`/finance/payments/${p.id}`} className="font-medium text-primary hover:underline">{p.number ?? "Draft"}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{p.vendor.name}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(p.paymentDate)}</RecordsTableCell>
                    <RecordsTableCell>{p.bankAccount.name}</RecordsTableCell>
                    <RecordsTableCell>{formatMoney(p.amount)}</RecordsTableCell>
                    <RecordsTableCell>{p.status === "POSTED" ? formatMoney(Number(p.amount.toString()) - Number(p.allocatedAmount.toString())) : "—"}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={p.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/finance/payments" />
        </CardContent>
      </Card>
    </div>
  );
}
