import { can, getAccessContext } from "@/lib/access";
import { listCompanies } from "@/features/companies/service";
import { listWarehouses } from "@/features/inventory/warehouses";
import { listProducts } from "@/features/catalog/service";
import { StockEntryForm } from "@/features/inventory/stock-entry-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function NewStockEntryPage() {
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Inventory", "Stock entries", "New"]} title="New stock entry" subtitle="Opening stock, receipts, issues, adjustments and transfers between warehouses." />;

  if (!can(ctx, "inventory.create") || !can(ctx, "company.view") || !can(ctx, "product.view")) {
    return (
      <div className="space-y-4">
        {header}
        <Card><CardContent className="pt-5 text-sm text-muted">You don&apos;t have permission to create stock entries.</CardContent></Card>
      </div>
    );
  }

  const [companies, warehouses, products] = await Promise.all([
    listCompanies(ctx),
    listWarehouses(ctx),
    // ponytail: first 100 active goods; switch to a search combobox when catalogs outgrow it
    listProducts(ctx, { pageSize: "100", status: "ACTIVE", type: "GOODS" }),
  ]);
  // Company-wide entries need full company access; branch-limited members pick a branch.
  const scopes = companies.flatMap((c) => [
    ...(ctx.companies.get(c.id) === "all" ? [{ value: `${c.id}:`, label: `${c.code} · company-wide` }] : []),
    ...c.branches.filter((b) => b.isActive).map((b) => ({ value: `${c.id}:${b.id}`, label: `${c.code} · ${b.name}` })),
  ]);
  const stocked = products.items.filter((p) => p.trackInventory);

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardHeader><CardTitle>Entry</CardTitle></CardHeader>
        <CardContent>
          {scopes.length === 0 || stocked.length === 0 ? (
            <p className="text-sm text-muted">
              {scopes.length === 0 ? "You need access to a company or branch to record stock." : "No active stock-tracked goods yet. Create a product first."}
            </p>
          ) : (
            <StockEntryForm
              scopes={scopes}
              warehouses={warehouses.filter((w) => w.isActive).map((w) => ({ id: w.id, companyId: w.companyId, label: `${w.code} · ${w.name}` }))}
              products={stocked.map((p) => ({
                id: p.id,
                sku: p.sku,
                name: p.name,
                uom: p.uom.code,
                trackingMode: p.trackingMode,
                hasExpiry: p.hasExpiry,
                cost: p.purchasePrice.toString(),
              }))}
              canPost={can(ctx, "inventory.post")}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
