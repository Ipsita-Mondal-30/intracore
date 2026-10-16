import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listDispatches, undispatchedDeliveries } from "@/features/service/dispatch";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const STATUSES = ["DISPATCHED", "IN_TRANSIT", "DELIVERED", "FAILED"];

export default async function DispatchPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Service", "Dispatch & POD"]} title="Dispatch and proof of delivery" subtitle="Track posted deliveries from dispatch to signed receipt." />;
  if (!can(ctx, "field.view")) return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view dispatches.</p></div>;

  const page = await listDispatches(ctx, listParams(params, ["status"]));
  const pending = can(ctx, "field.schedule") ? await undispatchedDeliveries(ctx) : [];

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar params={params} placeholder="Carrier, tracking, receiver" filters={[{ name: "status", label: "Status", options: STATUSES.map((s) => ({ value: s, label: humanize(s) })) }]} />
          <RecordsTable
            columns={[{ key: "delivery", label: "Delivery" }, { key: "customer", label: "Customer" }, { key: "carrier", label: "Carrier" }, { key: "dispatched", label: "Dispatched" }, { key: "status", label: "Status" }]}
            empty="Nothing dispatched yet."
          >
            {page.items.length
              ? page.items.map((d) => (
                  <RecordsTableRow key={d.id}>
                    <RecordsTableCell><Link href={`/service/dispatch/${d.id}`} className="font-medium text-primary hover:underline">{d.stockEntry.number}</Link></RecordsTableCell>
                    <RecordsTableCell>{d.stockEntry.customer?.name ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{[d.carrier, d.trackingNumber].filter(Boolean).join(" · ") || "—"}</RecordsTableCell>
                    <RecordsTableCell>{formatDateTime(d.dispatchedAt)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={d.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/service/dispatch" />
        </CardContent>
      </Card>
      {can(ctx, "field.schedule") ? (
        <Card>
          <CardHeader><CardTitle>Dispatch a delivery</CardTitle></CardHeader>
          <CardContent>
            {pending.length === 0 ? <p className="text-sm text-muted">No posted deliveries waiting for dispatch.</p> : (
              <ApiForm path="/dispatches" submitLabel="Dispatch" redirect="/service/dispatch/:id" className="grid gap-3 sm:grid-cols-3">
                <Field label="Delivery">
                  <Select name="stockEntryId" required>
                    {pending.map((e) => <option key={e.id} value={e.id}>{e.number} · {e.customer?.name ?? "—"} · {formatDate(e.postedAt)}</option>)}
                  </Select>
                </Field>
                <Field label="Carrier"><Input name="carrier" maxLength={120} /></Field>
                <Field label="Tracking number"><Input name="trackingNumber" maxLength={120} /></Field>
                <Field label="Vehicle number"><Input name="vehicleNumber" maxLength={40} /></Field>
                <Field label="Driver"><Input name="driverName" maxLength={120} /></Field>
              </ApiForm>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
