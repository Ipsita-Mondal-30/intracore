import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getWorkOrder } from "@/features/manufacturing/work-orders";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, formatMoney, formatQty, humanize } from "@/components/erp/format";

export default async function WorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const wo = await getWorkOrder(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = wo.status;
  const active = s === "RELEASED" || s === "IN_PROGRESS";
  const canRelease = can(ctx, "manufacturing.release");
  const canProduce = can(ctx, "manufacturing.produce");
  const inspections = can(ctx, "quality.view")
    ? await prisma.inspection.findMany({ where: { organizationId: ctx.organizationId, sourceType: "WORK_ORDER", sourceId: id }, orderBy: { createdAt: "desc" } })
    : [];
  const a = (action: string) => `/work-orders/${id}/${action}`;
  const short = wo.materials.some((m) => Number(m.shortage) > 0);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Manufacturing", "Work orders", wo.number]}
        title={wo.number}
        subtitle={`${wo.product.sku} · ${wo.product.name} · ${formatQty(wo.quantity)} ${wo.product.uom.code} · ${wo.company.code} / ${wo.warehouse.code}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            {s === "DRAFT" && canRelease ? <ActionButton path={a("release")} label="Release" variant="default" /> : null}
            {active && canRelease ? <ActionButton path={a("reserve")} label="Reserve materials" /> : null}
            {s === "RELEASED" && canProduce ? <ActionButton path={a("start")} label="Start" /> : null}
            {active && canProduce ? <ActionButton path={a("complete")} label="Complete" confirm="Complete this work order? Remaining reservations are released." /> : null}
            {(s === "DRAFT" || active) && canRelease ? (
              <ActionButton path={a("cancel")} label="Cancel" variant="ghost" prompt="Reason for cancelling (optional)" confirm="Cancel this work order?" />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Materials</CardTitle></CardHeader>
            <CardContent>
              {short && (s === "DRAFT" || active) ? (
                <p className="mb-3 rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning">Some materials are short in {wo.warehouse.code}. Receive stock, then use “Reserve materials”.</p>
              ) : null}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                    <tr className="border-b border-[var(--ic-border)]">
                      <th className="py-2 pr-2">Material</th>
                      <th className="py-2 pr-2 text-right">Required</th>
                      <th className="py-2 pr-2 text-right">Issued</th>
                      <th className="py-2 pr-2 text-right">Reserved</th>
                      <th className="py-2 pr-2 text-right">Free in warehouse</th>
                      <th className="py-2 text-right">Short</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wo.materials.map((m) => (
                      <tr key={m.id} className="border-b border-[var(--ic-border)] last:border-0">
                        <td className="py-2 pr-2">{m.product.name}<span className="block text-2xs text-subtle">{m.product.sku}</span></td>
                        <td className="py-2 pr-2 text-right">{formatQty(m.requiredQty)} {m.product.uom.code}</td>
                        <td className="py-2 pr-2 text-right">{formatQty(m.consumedQty)}</td>
                        <td className="py-2 pr-2 text-right">{formatQty(m.reserved)}</td>
                        <td className="py-2 pr-2 text-right">{formatQty(m.available)}</td>
                        <td className={`py-2 text-right font-medium ${Number(m.shortage) > 0 ? "text-danger" : ""}`}>{formatQty(m.shortage)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {active && canProduce ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>Issue materials</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <ActionButton path={a("issue")} label="Issue everything open" variant="default" confirm="Issue all open material quantities from the warehouse?" />
                  <ApiForm path={a("issue")} submitLabel="Issue" successMessage="Materials issued">
                    <Field label="Material">
                      <Select name="lines.0.productId" required defaultValue="">
                        <option value="" disabled>Choose…</option>
                        {wo.materials.map((m) => <option key={m.id} value={m.productId}>{m.product.sku} (open {formatQty(m.open)})</option>)}
                      </Select>
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Quantity"><Input name="lines.0.quantity" type="number" min="0.0001" step="any" required /></Field>
                      <Field label="Batch / serial"><Input name="lines.0.lotNumber" /></Field>
                    </div>
                    <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="allowOverIssue" /> Allow more than required (extra scrap)</label>
                  </ApiForm>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Receive finished goods</CardTitle></CardHeader>
                <CardContent>
                  <ApiForm path={a("receive")} submitLabel="Receive" successMessage="Finished goods received">
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Quantity" hint={`${formatQty(Number(wo.quantity) - Number(wo.producedQty))} still planned`}>
                        <Input name="quantity" type="number" min="0.0001" step="any" required />
                      </Field>
                      {wo.product.trackingMode !== "NONE" ? <Field label="Batch / serial"><Input name="lotNumber" required /></Field> : null}
                      {wo.product.hasExpiry ? <Field label="Expiry"><Input name="expiryDate" type="date" required /></Field> : null}
                    </div>
                    <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="allowOverReceipt" /> Allow more than planned</label>
                  </ApiForm>
                </CardContent>
              </Card>
            </div>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Quality inspections</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {s !== "DRAFT" && s !== "CANCELLED" && can(ctx, "quality.inspect") ? (
                <Link href={`/manufacturing/quality/inspect?source=WORK_ORDER:${id}`} className="text-primary hover:underline">Record an inspection</Link>
              ) : null}
              {inspections.length === 0 ? <p className="text-muted">No inspections yet.</p> : null}
              <ul className="space-y-1">
                {inspections.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={i.result} />
                    <span>{formatQty(i.inspectedQty)} inspected · {formatQty(i.rejectedQty)} rejected</span>
                    <span className="text-2xs text-subtle">{formatDate(i.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Production</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">Planned / produced / rejected</dt><dd>{formatQty(wo.quantity)} / {formatQty(wo.producedQty)} / {formatQty(wo.rejectedQty)}</dd></div>
                <div><dt className="text-subtle">Bill of materials</dt><dd><Link href={`/manufacturing/boms/${wo.bom.id}`} className="text-primary hover:underline">Version {wo.bom.version}</Link></dd></div>
                <div><dt className="text-subtle">Planned</dt><dd>{formatDate(wo.plannedStart)} → {formatDate(wo.plannedEnd)}</dd></div>
                <div><dt className="text-subtle">Materials consumed</dt><dd>{formatMoney(wo.costs.consumedValue)}</dd></div>
                <div><dt className="text-subtle">Absorbed into finished goods</dt><dd>{formatMoney(wo.costs.absorbedValue)}</dd></div>
                <div><dt className="text-subtle">Still in WIP</dt><dd>{formatMoney(wo.costs.wipValue)}</dd></div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Stock entries</CardTitle></CardHeader>
            <CardContent>
              {wo.stockEntries.length === 0 ? <p className="text-sm text-muted">Nothing issued or received yet.</p> : null}
              <ul className="space-y-1 text-sm">
                {wo.stockEntries.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2">
                    <Link href={`/inventory/entries/${e.id}`} className="text-primary hover:underline">{e.number}</Link>
                    <span className="text-muted">{humanize(e.type)}</span>
                    <StatusBadge status={e.status} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="work_order" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
