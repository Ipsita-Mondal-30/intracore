import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { getStockLevels } from "@/features/inventory/stock";
import { listWarehouses } from "@/features/inventory/warehouses";
import { listCompanies } from "@/features/companies/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { param } from "@/components/erp/list-controls";
import { formatQty } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function StockLevelsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const companyId = param(params, "companyId") || undefined;
  const warehouseId = param(params, "warehouseId") || undefined;
  const lowOnly = param(params, "lowOnly") === "true";

  const [rows, warehouses, companies] = await Promise.all([
    getStockLevels(ctx, { companyId, warehouseId, lowOnly: lowOnly ? "true" : undefined }),
    listWarehouses(ctx, companyId),
    can(ctx, "company.view") ? listCompanies(ctx) : [],
  ]);

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Inventory", "Stock levels"]} title="Stock levels" subtitle="On hand, reserved for confirmed orders, and available, per warehouse." />

      <Card>
        <CardContent className="pt-5">
          <form method="get" className="mb-4 flex flex-wrap items-center gap-2">
            {companies.length > 1 ? (
              <Select name="companyId" defaultValue={companyId ?? ""} className="max-w-[220px]" aria-label="Company">
                <option value="">Company: all</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </Select>
            ) : null}
            <Select name="warehouseId" defaultValue={warehouseId ?? ""} className="max-w-[220px]" aria-label="Warehouse">
              <option value="">Warehouse: all</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.company.code} · {w.code} · {w.name}</option>)}
            </Select>
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" name="lowOnly" value="true" defaultChecked={lowOnly} /> Low stock only
            </label>
            <Button type="submit" size="sm" variant="secondary">Apply</Button>
          </form>

          <RecordsTable
            columns={[
              { key: "product", label: "Product" },
              { key: "warehouse", label: "Warehouse" },
              { key: "onHand", label: "On hand", className: "text-right" },
              { key: "reserved", label: "Reserved", className: "text-right" },
              { key: "available", label: "Available", className: "text-right" },
              { key: "reorder", label: "Reorder level", className: "text-right" },
              { key: "low", label: "" },
            ]}
            empty={lowOnly ? "Nothing is at or below its reorder level." : "No stock recorded yet. Post an opening stock entry to start."}
          >
            {rows.length
              ? rows.map((r) => (
                  <RecordsTableRow key={`${r.warehouse.id}:${r.product.id}`}>
                    <RecordsTableCell>
                      <Link href={`/inventory/products/${r.product.id}`} className="font-medium text-primary hover:underline">{r.product.name}</Link>
                      <span className="block text-2xs text-subtle">{r.product.sku}</span>
                    </RecordsTableCell>
                    <RecordsTableCell>{r.warehouse.code} · {r.warehouse.name}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatQty(r.onHand)} {r.product.uom.code}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatQty(r.reserved)}</RecordsTableCell>
                    <RecordsTableCell className={Number(r.available) <= 0 ? "text-right font-medium text-danger" : "text-right font-medium"}>
                      {formatQty(r.available)}
                    </RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatQty(r.product.reorderLevel)}</RecordsTableCell>
                    <RecordsTableCell>{r.low ? <Badge tone="warning">Low</Badge> : null}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
        </CardContent>
      </Card>
    </div>
  );
}
