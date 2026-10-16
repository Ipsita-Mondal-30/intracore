import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { fullCompanyIds } from "@/features/manufacturing/scope";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ApiForm, Field } from "@/components/erp/api-form";
import { param } from "@/components/erp/list-controls";
import { formatQty } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Step 1 picks a template and what is inspected (GET form); step 2 records the results. */
export default async function InspectPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Manufacturing", "Quality", "Inspect"]} title="Record an inspection" subtitle="Results are checked against the template; failed checks reject quantity and raise an NCR." />;
  if (!can(ctx, "quality.inspect")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to record inspections.</p></div>;
  }
  const companyIds = fullCompanyIds(ctx);
  const templateId = param(params, "templateId") ?? "";
  const [sourceType, sourceId] = (param(params, "source") ?? ":").split(":");

  const template = templateId
    ? await prisma.inspectionTemplate.findFirst({ where: { id: templateId, organizationId: ctx.organizationId, isActive: true }, include: { items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } } })
    : null;
  const grn = sourceType === "GOODS_RECEIPT" && sourceId
    ? await prisma.stockEntry.findFirst({
        where: { id: sourceId, organizationId: ctx.organizationId, type: "GOODS_RECEIPT", status: "POSTED", companyId: { in: companyIds } },
        include: { lines: { include: { product: { select: { id: true, sku: true, name: true } } } }, vendor: { select: { name: true } } },
      })
    : null;
  const wo = sourceType === "WORK_ORDER" && sourceId
    ? await prisma.workOrder.findFirst({ where: { id: sourceId, organizationId: ctx.organizationId, companyId: { in: companyIds } }, include: { product: { select: { id: true, sku: true, name: true } } } })
    : null;

  if (!template || (!grn && !wo)) {
    const [templates, grns, wos] = await Promise.all([
      prisma.inspectionTemplate.findMany({ where: { organizationId: ctx.organizationId, isActive: true }, orderBy: { name: "asc" } }),
      prisma.stockEntry.findMany({
        where: { organizationId: ctx.organizationId, type: "GOODS_RECEIPT", status: "POSTED", companyId: { in: companyIds } },
        include: { vendor: { select: { name: true } } },
        orderBy: { postedAt: "desc" },
        take: 50,
      }),
      prisma.workOrder.findMany({
        where: { organizationId: ctx.organizationId, companyId: { in: companyIds }, status: { in: ["RELEASED", "IN_PROGRESS", "COMPLETED"] } },
        include: { product: { select: { sku: true } } },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    return (
      <div className="space-y-4">
        {header}
        <Card>
          <CardContent className="pt-5">
            <form method="get" className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-subtle">Template</span>
                <Select name="templateId" defaultValue={templateId} required>
                  <option value="" disabled>Choose…</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-subtle">Inspecting</span>
                <Select name="source" defaultValue={sourceId ? `${sourceType}:${sourceId}` : ""} required>
                  <option value="" disabled>Choose…</option>
                  <optgroup label="Goods receipts">
                    {grns.map((g) => <option key={g.id} value={`GOODS_RECEIPT:${g.id}`}>{g.number}{g.vendor ? ` · ${g.vendor.name}` : ""}</option>)}
                  </optgroup>
                  <optgroup label="Work orders">
                    {wos.map((w) => <option key={w.id} value={`WORK_ORDER:${w.id}`}>{w.number} · {w.product.sku}</option>)}
                  </optgroup>
                </Select>
              </label>
              <Button type="submit" size="sm" variant="secondary">Continue</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  const products = grn
    ? [...new Map(grn.lines.map((l) => [l.product.id, { ...l.product, qty: l.baseQuantity.toString() }])).values()]
    : [{ ...wo!.product, qty: wo!.quantity.toString() }];

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardHeader><CardTitle>{`${template.name} · ${grn ? `${grn.number}${grn.vendor ? ` (${grn.vendor.name})` : ""}` : wo!.number}`}</CardTitle></CardHeader>
        <CardContent>
          <ApiForm path="/inspections" submitLabel="Record inspection" successMessage="Inspection recorded" redirect="/manufacturing/quality">
            <input type="hidden" name="templateId" value={template.id} />
            <input type="hidden" name="sourceType" value={sourceType} />
            <input type="hidden" name="sourceId" value={sourceId} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Product">
                <Select name="productId" defaultValue={products[0].id}>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name} ({formatQty(p.qty)})</option>)}
                </Select>
              </Field>
              <Field label="Quantity inspected"><Input name="inspectedQty" type="number" min="0.0001" step="any" required /></Field>
              <Field label="Quantity rejected" hint="Empty: all of it if a check fails, else none"><Input name="rejectedQty" type="number" min="0" step="any" /></Field>
            </div>

            <div className="space-y-2">
              {template.items.map((item, i) => (
                <div key={item.id} className="grid items-center gap-2 sm:grid-cols-[1fr_220px]">
                  <input type="hidden" name={`results.${i}.itemId`} value={item.id} />
                  <span className="text-sm">
                    {item.label}
                    {item.required ? <span className="text-danger"> *</span> : null}
                    {item.type === "NUMERIC" ? <span className="ml-2 text-2xs text-subtle">{item.minValue?.toString() ?? "−∞"} – {item.maxValue?.toString() ?? "∞"}</span> : null}
                  </span>
                  {item.type === "BOOLEAN" ? (
                    <Select name={`results.${i}.value`} defaultValue="" aria-label={item.label}>
                      <option value="">—</option>
                      <option value="true">Pass</option>
                      <option value="false">Fail</option>
                    </Select>
                  ) : (
                    <Input name={`results.${i}.value`} type={item.type === "NUMERIC" ? "number" : "text"} step="any" aria-label={item.label} />
                  )}
                </div>
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="raiseNcr" defaultChecked /> Raise an NCR for rejections</label>
              <Field label="NCR severity">
                <Select name="severity" defaultValue="MINOR">
                  <option value="MINOR">Minor</option>
                  <option value="MAJOR">Major</option>
                  <option value="CRITICAL">Critical</option>
                </Select>
              </Field>
              {grn && can(ctx, "inventory.create") && can(ctx, "inventory.post") ? (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="returnRejected" /> Return rejected goods to the vendor</label>
              ) : null}
            </div>
            <Field label="NCR description (optional)"><Textarea name="ncrDescription" rows={2} /></Field>
          </ApiForm>
        </CardContent>
      </Card>
    </div>
  );
}
