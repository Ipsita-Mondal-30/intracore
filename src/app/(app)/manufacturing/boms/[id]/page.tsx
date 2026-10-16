import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getBom } from "@/features/manufacturing/boms";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDateTime, formatQty } from "@/components/erp/format";
import { BomLineRows, stockedProducts } from "../line-rows";

export default async function BomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const bom = await getBom(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const canEdit = can(ctx, "manufacturing.create");
  const editable = canEdit && bom.status === "DRAFT";
  const products = editable ? await stockedProducts(ctx.organizationId) : [];
  const a = (action: string) => `/boms/${id}/${action}`;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Manufacturing", "Bills of materials", `${bom.product.sku} v${bom.version}`]}
        title={`${bom.product.name} — version ${bom.version}`}
        subtitle={`Makes ${formatQty(bom.outputQuantity)} ${bom.product.uom.code} · used by ${bom._count.workOrders} work order(s)`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={bom.status} />
            {canEdit && bom.status === "DRAFT" ? <ActionButton path={a("activate")} label="Activate" variant="default" confirm="Activate this version? The current active version is archived." /> : null}
            {canEdit ? <ActionButton path={a("copy")} label="Copy to new version" redirectTo="/manufacturing/boms/:id" /> : null}
            {canEdit && bom.status !== "ARCHIVED" ? <ActionButton path={a("archive")} label="Archive" variant="ghost" confirm="Archive this version?" /> : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Components</CardTitle></CardHeader>
            <CardContent>
              {editable ? (
                <ApiForm path={`/boms/${id}`} method="PATCH" successMessage="Bill of materials updated">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Output quantity"><Input name="outputQuantity" type="number" min="0.0001" step="any" defaultValue={bom.outputQuantity.toString()} /></Field>
                    <Field label="Notes"><Input name="notes" defaultValue={bom.notes ?? ""} data-nullable /></Field>
                  </div>
                  <BomLineRows
                    products={products}
                    initial={bom.lines.map((l) => ({ componentId: l.componentId, quantity: l.quantity.toString(), scrapPercent: l.scrapPercent.toString() }))}
                  />
                </ApiForm>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                    <tr className="border-b border-[var(--ic-border)]">
                      <th className="py-2 pr-2">Component</th>
                      <th className="py-2 pr-2 text-right">Quantity</th>
                      <th className="py-2 text-right">Scrap</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bom.lines.map((l) => (
                      <tr key={l.id} className="border-b border-[var(--ic-border)] last:border-0">
                        <td className="py-2 pr-2">{l.component.name}<span className="block text-2xs text-subtle">{l.component.sku}</span></td>
                        <td className="py-2 pr-2 text-right">{formatQty(l.quantity)} {l.component.uom.code}</td>
                        <td className="py-2 text-right">{formatQty(l.scrapPercent)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
          {bom.notes && !editable ? (
            <Card>
              <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
              <CardContent><p className="whitespace-pre-line text-sm">{bom.notes}</p></CardContent>
            </Card>
          ) : null}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p><span className="text-subtle">Created</span> {formatDateTime(bom.createdAt)}</p>
              <p>
                <Link href={`/manufacturing/boms?productId=${bom.productId}`} className="text-primary hover:underline">All versions</Link>
                {" · "}
                <Link href={`/manufacturing/mrp?productId=${bom.productId}`} className="text-primary hover:underline">Plan materials</Link>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="bom" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
