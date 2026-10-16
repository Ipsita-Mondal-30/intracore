import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listWorkOrders } from "@/features/manufacturing/work-orders";
import { fullCompanyIds } from "@/features/manufacturing/scope";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatQty, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUSES = ["DRAFT", "RELEASED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];

export default async function WorkOrdersPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Manufacturing", "Work orders"]} title="Work orders" subtitle="Make products from their bills of materials: release reserves materials, issue consumes them, receipts add finished goods." />;
  if (!can(ctx, "manufacturing.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have access to manufacturing.</p></div>;
  }

  const page = await listWorkOrders(ctx, listParams(params, ["status", "productId"]));
  const filtered = Boolean(param(params, "q") || param(params, "status"));
  const canCreate = can(ctx, "manufacturing.create");
  const [boms, warehouses] = canCreate
    ? await Promise.all([
        prisma.bom.findMany({
          where: { organizationId: ctx.organizationId, status: "ACTIVE" },
          include: { product: { select: { id: true, sku: true, name: true } } },
          orderBy: { product: { name: "asc" } },
          take: 500,
        }),
        prisma.warehouse.findMany({
          where: { organizationId: ctx.organizationId, companyId: { in: fullCompanyIds(ctx) }, isActive: true },
          include: { company: { select: { code: true } } },
          orderBy: [{ companyId: "asc" }, { code: "asc" }],
        }),
      ])
    : [[], []];

  return (
    <div className="space-y-4">
      {header}

      {canCreate ? (
        <Card>
          <CardHeader><CardTitle>New work order</CardTitle></CardHeader>
          <CardContent>
            {boms.length === 0 || warehouses.length === 0 ? (
              <p className="text-sm text-muted">
                {boms.length === 0 ? <>Activate a <Link href="/manufacturing/boms" className="text-primary hover:underline">bill of materials</Link> first.</> : "You need company-wide access to a company with a warehouse."}
              </p>
            ) : (
              <ApiForm path="/work-orders" submitLabel="Create work order" redirect="/manufacturing/work-orders/:id" className="grid gap-3 sm:grid-cols-5">
                <Field label="Product (active BOM)">
                  <Select name="productId" required defaultValue="">
                    <option value="" disabled>Choose…</option>
                    {boms.map((b) => <option key={b.id} value={b.productId}>{b.product.sku} · {b.product.name} (v{b.version})</option>)}
                  </Select>
                </Field>
                <Field label="Quantity"><Input name="quantity" type="number" min="0.0001" step="any" required /></Field>
                <Field label="Warehouse">
                  <Select name="warehouse" data-split="companyId,warehouseId" required defaultValue="">
                    <option value="" disabled>Choose…</option>
                    {warehouses.map((w) => <option key={w.id} value={`${w.companyId}:${w.id}`}>{w.company.code} · {w.code} ({w.name})</option>)}
                  </Select>
                </Field>
                <Field label="Planned start"><Input name="plannedStart" type="date" /></Field>
                <Field label="Planned end"><Input name="plannedEnd" type="date" /></Field>
              </ApiForm>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number…"
            filters={[{ name: "status", label: "Status", options: STATUSES.map((v) => ({ value: v, label: humanize(v) })) }]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Number" },
              { key: "product", label: "Product" },
              { key: "qty", label: "Planned", className: "text-right" },
              { key: "produced", label: "Produced", className: "text-right" },
              { key: "warehouse", label: "Warehouse" },
              { key: "dates", label: "Planned dates" },
              { key: "status", label: "Status" },
            ]}
            empty={filtered ? "No work orders match your filters." : "No work orders yet."}
          >
            {page.items.length
              ? page.items.map((w) => (
                  <RecordsTableRow key={w.id}>
                    <RecordsTableCell>
                      <Link href={`/manufacturing/work-orders/${w.id}`} className="font-medium text-primary hover:underline">{w.number}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{w.product.sku} · {w.product.name}<span className="block text-2xs text-subtle">BOM v{w.bom.version}</span></RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatQty(w.quantity)}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatQty(w.producedQty)}</RecordsTableCell>
                    <RecordsTableCell>{w.warehouse.code}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(w.plannedStart)} → {formatDate(w.plannedEnd)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={w.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/manufacturing/work-orders" />
        </CardContent>
      </Card>
    </div>
  );
}
