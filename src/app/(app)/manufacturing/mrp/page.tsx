import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { materialRequirements } from "@/features/manufacturing/mrp";
import { fullCompanyIds } from "@/features/manufacturing/scope";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { param } from "@/components/erp/list-controls";
import { formatQty } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const th = "py-2 pr-2";
const num = "py-2 pr-2 text-right";

export default async function MrpPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Manufacturing", "Material planning"]} title="Material planning" subtitle="Explode bills of materials and see what is short. Available = on hand − reserved." />;
  const companyIds = fullCompanyIds(ctx);
  if (!can(ctx, "manufacturing.view") || companyIds.length === 0) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You need manufacturing access with company-wide scope.</p></div>;
  }

  const companyId = param(params, "companyId") ?? companyIds[0];
  const warehouseId = param(params, "warehouseId") || undefined;
  const productId = param(params, "productId") || undefined;
  const quantity = param(params, "quantity") || (productId ? "1" : undefined);
  const [companies, warehouses, boms] = await Promise.all([
    prisma.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: companyIds } }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
    prisma.warehouse.findMany({ where: { organizationId: ctx.organizationId, companyId, isActive: true }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
    prisma.bom.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, include: { product: { select: { id: true, sku: true, name: true } } }, orderBy: { product: { name: "asc" } }, take: 500 }),
  ]);

  let error: string | null = null;
  const run = async (query: Record<string, string | undefined>) => {
    try {
      return await materialRequirements(ctx, query);
    } catch (e) {
      if (isAppError(e)) error = e.message;
      else if (e instanceof Error && e.name === "ZodError") error = "Check the quantity.";
      else throw e;
      return null;
    }
  };
  const plan = productId ? await run({ companyId, warehouseId, productId, quantity }) : null;
  const open = await run({ companyId, warehouseId });
  const explosion = plan?.mode === "explosion" ? plan : null;
  const openLines = open?.mode === "open" ? open.lines : [];

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <form method="get" className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-subtle">Company</span>
              <Select name="companyId" defaultValue={companyId}>{companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-subtle">Warehouse</span>
              <Select name="warehouseId" defaultValue={warehouseId ?? ""}>
                <option value="">Whole company</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
              </Select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-subtle">Product to make</span>
              <Select name="productId" defaultValue={productId ?? ""}>
                <option value="">Open work orders only</option>
                {boms.map((b) => <option key={b.id} value={b.productId}>{b.product.sku} · {b.product.name}</option>)}
              </Select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-subtle">Quantity</span>
              <Input name="quantity" type="number" min="0.0001" step="any" defaultValue={quantity ?? ""} className="w-28" />
            </label>
            <Button type="submit" size="sm" variant="secondary">Plan</Button>
          </form>
          {error ? <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-danger">{error}</p> : null}
        </CardContent>
      </Card>

      {explosion ? (
        <Card>
          <CardHeader><CardTitle>{`To make ${formatQty(explosion.quantity)} × ${explosion.product.sku} (BOM v${explosion.bom.version})`}</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr className="border-b border-[var(--ic-border)]">
                  <th className={th}>Level</th><th className={th}>Item</th><th className={th}>Make / buy</th>
                  <th className={num}>Required</th><th className={num}>On hand</th><th className={num}>Reserved</th><th className={num}>Available</th><th className={num}>Short</th>
                </tr>
              </thead>
              <tbody>
                {explosion.lines.map((l) => (
                  <tr key={l.product.id} className="border-b border-[var(--ic-border)] last:border-0">
                    <td className={th}>{l.level}</td>
                    <td className={th}>{l.product.name}<span className="block text-2xs text-subtle">{l.product.sku}</span></td>
                    <td className={th}>{l.source === "MAKE" ? "Make" : "Buy"}</td>
                    <td className={num}>{formatQty(l.required)} {l.product.uom.code}</td>
                    <td className={num}>{formatQty(l.onHand)}</td>
                    <td className={num}>{formatQty(l.reserved)}</td>
                    <td className={num}>{formatQty(l.available)}</td>
                    <td className={`${num} font-medium ${Number(l.shortage) > 0 ? "text-danger" : ""}`}>{formatQty(l.shortage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-2xs text-subtle">Shortages of made items are exploded into their own components; shortages of bought items need purchase orders.</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Open work orders</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {openLines.length === 0 ? (
            <p className="text-sm text-muted">No open material requirements.</p>
          ) : (
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr className="border-b border-[var(--ic-border)]">
                  <th className={th}>Material</th><th className={th}>Warehouse</th><th className={num}>Still to issue</th>
                  <th className={num}>Reserved for orders</th><th className={num}>Free stock</th><th className={num}>Short</th><th className={th}>Work orders</th>
                </tr>
              </thead>
              <tbody>
                {openLines.map((l) => (
                  <tr key={`${l.warehouse.id}:${l.product.id}`} className="border-b border-[var(--ic-border)] last:border-0">
                    <td className={th}>{l.product.name}<span className="block text-2xs text-subtle">{l.product.sku}</span></td>
                    <td className={th}>{l.warehouse.code}</td>
                    <td className={num}>{formatQty(l.openRequirement)} {l.product.uom.code}</td>
                    <td className={num}>{formatQty(l.reservedForWorkOrders)}</td>
                    <td className={num}>{formatQty(l.available)}</td>
                    <td className={`${num} font-medium ${Number(l.shortage) > 0 ? "text-danger" : ""}`}>{formatQty(l.shortage)}</td>
                    <td className={th}>
                      {l.workOrders.map((w, i) => (
                        <span key={w.id}>{i ? ", " : ""}<Link href={`/manufacturing/work-orders/${w.id}`} className="text-primary hover:underline">{w.number}</Link></span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
