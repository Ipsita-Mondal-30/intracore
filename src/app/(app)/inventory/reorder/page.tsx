import Link from "next/link";
import { assertCan, assertCompanyAccess, can, getAccessContext } from "@/lib/access";
import { getReorderSuggestions } from "@/features/inventory/stock";
import { listCompanies } from "@/features/companies/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { param } from "@/components/erp/list-controls";
import { formatMoney, formatQty } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ReorderPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  assertCan(ctx, "inventory.view");
  const companies = can(ctx, "company.view") ? await listCompanies(ctx) : [];
  const companyId = param(params, "companyId") || companies[0]?.id || [...ctx.companies.keys()][0];
  if (companyId) assertCompanyAccess(ctx, companyId);
  const suggestions = companyId ? await getReorderSuggestions(ctx, companyId) : [];
  const canOrder = can(ctx, "purchase_order.create");

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Inventory", "Reorder"]}
        title="Reorder suggestions"
        subtitle="Products whose available plus incoming quantity is at or below their reorder level."
      />

      <Card>
        <CardContent className="pt-5">
          {companies.length > 1 ? (
            <form method="get" className="mb-4 flex flex-wrap items-center gap-2">
              <Select name="companyId" defaultValue={companyId} className="max-w-xs" aria-label="Company">
                {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </Select>
              <Button type="submit" size="sm" variant="secondary">Apply</Button>
            </form>
          ) : null}
          <RecordsTable
            columns={[
              { key: "product", label: "Product" },
              { key: "available", label: "Available", className: "text-right" },
              { key: "incoming", label: "Incoming", className: "text-right" },
              { key: "level", label: "Reorder level", className: "text-right" },
              { key: "suggested", label: "Suggested qty", className: "text-right" },
              { key: "price", label: "Last purchase price", className: "text-right" },
              { key: "action", label: "" },
            ]}
            empty="Nothing to reorder."
          >
            {suggestions.length
              ? suggestions.map((s) => (
                  <RecordsTableRow key={s.product.id}>
                    <RecordsTableCell>
                      <Link href={`/inventory/products/${s.product.id}`} className="font-medium text-primary hover:underline">{s.product.name}</Link>
                      <span className="block text-2xs text-subtle">{s.product.sku}</span>
                    </RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatQty(s.available)} {s.product.uom}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatQty(s.incoming)}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatQty(s.reorderLevel)}</RecordsTableCell>
                    <RecordsTableCell className="text-right font-medium">{formatQty(s.suggestedQuantity)}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatMoney(s.product.purchasePrice)}</RecordsTableCell>
                    <RecordsTableCell>
                      {canOrder ? (
                        <Link
                          href={`/purchasing/orders/new?productId=${s.product.id}&quantity=${encodeURIComponent(s.suggestedQuantity)}`}
                          className="text-sm text-primary hover:underline"
                        >
                          Create PO
                        </Link>
                      ) : null}
                    </RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
        </CardContent>
      </Card>
    </div>
  );
}
