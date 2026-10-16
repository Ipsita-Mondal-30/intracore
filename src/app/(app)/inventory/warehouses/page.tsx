import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listWarehouses } from "@/features/inventory/warehouses";
import { reconcileStock } from "@/features/inventory/stock";
import { listCompanies } from "@/features/companies/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { param } from "@/components/erp/list-controls";
import { formatMoney, formatQty } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function WarehousesPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const canAdmin = can(ctx, "inventory.administer");
  const [warehouses, companies] = await Promise.all([listWarehouses(ctx), can(ctx, "company.view") ? listCompanies(ctx) : []]);
  const fullCompanies = companies.filter((c) => ctx.companies.get(c.id) === "all");

  const reconcileId = param(params, "reconcile");
  const report = canAdmin && reconcileId && ctx.companies.has(reconcileId) ? await reconcileStock(ctx, reconcileId, {}) : null;
  const [diffProducts, diffLocations] = report
    ? await Promise.all([
        prisma.product.findMany({
          where: { organizationId: ctx.organizationId, id: { in: [...report.balanceDiffs, ...report.valuationDiffs].map((d) => d.productId) } },
          select: { id: true, sku: true },
        }),
        prisma.storageLocation.findMany({
          where: { organizationId: ctx.organizationId, id: { in: report.balanceDiffs.map((d) => d.locationId) } },
          select: { id: true, code: true, warehouse: { select: { code: true } } },
        }),
      ])
    : [[], []];
  const sku = new Map(diffProducts.map((p) => [p.id, p.sku]));
  const location = new Map(diffLocations.map((l) => [l.id, `${l.warehouse.code} / ${l.code}`]));

  const groups = [...new Set(warehouses.map((w) => w.companyId))].map((companyId) => ({
    companyId,
    company: warehouses.find((w) => w.companyId === companyId)!.company,
    warehouses: warehouses.filter((w) => w.companyId === companyId),
  }));

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Inventory", "Warehouses"]} title="Warehouses" subtitle="Where stock is kept. Each warehouse has one or more storage locations." />

      {canAdmin && fullCompanies.length ? (
        <Card>
          <CardHeader><CardTitle>New warehouse</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/warehouses" submitLabel="Create warehouse" successMessage="Warehouse created" className="grid gap-3 sm:grid-cols-4">
              <Field label="Company">
                <Select name="companyId" required>
                  {fullCompanies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
                </Select>
              </Field>
              <Field label="Branch" hint="Optional; must belong to the company">
                <Select name="branchId" data-nullable>
                  <option value="">None</option>
                  {fullCompanies.flatMap((c) => c.branches.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{c.code} · {b.name}</option>))}
                </Select>
              </Field>
              <Field label="Code"><Input name="code" required /></Field>
              <Field label="Name"><Input name="name" required /></Field>
              <Field label="Address" className="sm:col-span-4"><Input name="address" /></Field>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}

      {groups.length === 0 ? (
        <Card><CardContent className="pt-5 text-sm text-muted">No warehouses yet.</CardContent></Card>
      ) : null}

      {groups.map((g) => (
        <Card key={g.companyId}>
          <CardHeader><CardTitle>{g.company.code} · {g.company.name}</CardTitle></CardHeader>
          <CardContent className="divide-y divide-[var(--ic-border)]">
            {g.warehouses.map((w) => {
              const manage = canAdmin && ctx.companies.get(w.companyId) === "all";
              return (
                <div key={w.id} className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-3">
                  <div className="space-y-1 text-sm">
                    <p className="font-medium">
                      {w.code} · {w.name} {w.isActive ? null : <Badge tone="neutral">Inactive</Badge>}
                    </p>
                    <p className="text-2xs text-subtle">{[w.branch ? `Branch ${w.branch.name}` : "No branch", w.address].filter(Boolean).join(" · ")}</p>
                    {manage ? (
                      <ActionButton
                        path={`/warehouses/${w.id}`}
                        method="PATCH"
                        body={{ isActive: !w.isActive }}
                        label={w.isActive ? "Deactivate" : "Activate"}
                        confirm={w.isActive ? "Deactivate this warehouse? It can no longer be picked for new orders or entries." : undefined}
                        variant="ghost"
                      />
                    ) : null}
                  </div>
                  <div className="text-sm">
                    <p className="mb-1 text-2xs uppercase tracking-wide text-subtle">Locations</p>
                    {w.locations.length ? (
                      <ul className="space-y-0.5">
                        {w.locations.map((l) => (
                          <li key={l.id}>
                            {l.code} · {l.name} {l.isDefault ? <Badge tone="primary">Default</Badge> : null}
                          </li>
                        ))}
                      </ul>
                    ) : <p className="text-muted">None</p>}
                  </div>
                  {manage ? (
                    <ApiForm path={`/warehouses/${w.id}/locations`} submitLabel="Add location" successMessage="Location added" className="grid grid-cols-2 gap-2">
                      <Input name="code" placeholder="Code" required aria-label="Location code" />
                      <Input name="name" placeholder="Name" required aria-label="Location name" />
                      <label className="col-span-2 flex items-center gap-2 text-xs text-muted">
                        <input type="checkbox" name="isDefault" /> Make default
                      </label>
                    </ApiForm>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}

      {canAdmin && groups.length ? (
        <Card>
          <CardHeader><CardTitle>Check stock integrity</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted">Compares cached balances and valuation with the stock ledger. Checking changes nothing.</p>
            <form method="get" className="flex flex-wrap items-center gap-2">
              <Select name="reconcile" defaultValue={reconcileId ?? ""} className="max-w-xs" aria-label="Company" required>
                {groups.map((g) => <option key={g.companyId} value={g.companyId}>{g.company.code} · {g.company.name}</option>)}
              </Select>
              <Button type="submit" size="sm" variant="secondary">Check</Button>
            </form>

            {report ? (
              report.balanceDiffs.length === 0 && report.valuationDiffs.length === 0 ? (
                <p className="rounded-xl bg-success-soft px-3 py-2 text-sm text-success">Caches match the ledger.</p>
              ) : (
                <div className="space-y-4">
                  {report.balanceDiffs.length ? (
                    <table className="w-full text-sm">
                      <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                        <tr><th className="py-1 pr-2">Product</th><th className="py-1 pr-2">Location</th><th className="py-1 pr-2 text-right">Ledger</th><th className="py-1 text-right">Cached</th></tr>
                      </thead>
                      <tbody>
                        {report.balanceDiffs.map((d) => (
                          <tr key={`${d.locationId}:${d.productId}:${d.lotId ?? ""}`} className="border-t border-[var(--ic-border)]">
                            <td className="py-1 pr-2">{sku.get(d.productId) ?? d.productId}{d.lotId ? " (lot)" : ""}</td>
                            <td className="py-1 pr-2">{location.get(d.locationId) ?? d.locationId}</td>
                            <td className="py-1 pr-2 text-right">{formatQty(d.ledger)}</td>
                            <td className="py-1 text-right text-danger">{d.cached === "missing" ? "missing" : formatQty(d.cached)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                  {report.valuationDiffs.length ? (
                    <table className="w-full text-sm">
                      <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                        <tr><th className="py-1 pr-2">Product</th><th className="py-1 pr-2 text-right">Ledger qty</th><th className="py-1 pr-2 text-right">Cached qty</th><th className="py-1 pr-2 text-right">Ledger value</th><th className="py-1 text-right">Cached value</th></tr>
                      </thead>
                      <tbody>
                        {report.valuationDiffs.map((d) => (
                          <tr key={d.productId} className="border-t border-[var(--ic-border)]">
                            <td className="py-1 pr-2">{sku.get(d.productId) ?? d.productId}</td>
                            <td className="py-1 pr-2 text-right">{formatQty(d.ledgerQuantity)}</td>
                            <td className="py-1 pr-2 text-right">{d.cachedQuantity === "missing" ? "missing" : formatQty(d.cachedQuantity)}</td>
                            <td className="py-1 pr-2 text-right">{formatMoney(d.ledgerValue)}</td>
                            <td className="py-1 text-right">{d.cachedValue === "missing" ? "missing" : formatMoney(d.cachedValue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                  <ActionButton
                    path="/stock/reconcile"
                    body={{ companyId: report.companyId, fix: true }}
                    label="Repair caches from ledger"
                    confirm="Rebuild cached balances and valuation from the ledger for this company? The ledger itself is not changed."
                    variant="danger"
                  />
                </div>
              )
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
