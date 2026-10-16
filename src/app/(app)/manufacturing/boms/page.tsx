import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listBoms } from "@/features/manufacturing/boms";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, humanize } from "@/components/erp/format";
import { BomLineRows, stockedProducts } from "./line-rows";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function BomsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Manufacturing", "Bills of materials"]} title="Bills of materials" subtitle="Components per product, by version. One active version per product; active versions are frozen — copy to change." />;
  if (!can(ctx, "manufacturing.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have access to manufacturing.</p></div>;
  }
  const page = await listBoms(ctx, listParams(params, ["status", "productId"]));
  const canCreate = can(ctx, "manufacturing.create");
  const products = canCreate ? await stockedProducts(ctx.organizationId) : [];

  return (
    <div className="space-y-4">
      {header}

      {canCreate ? (
        <Card>
          <CardHeader><CardTitle>New bill of materials</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/boms" submitLabel="Create draft" redirect="/manufacturing/boms/:id">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Product made">
                  <Select name="productId" required defaultValue="">
                    <option value="" disabled>Choose…</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
                  </Select>
                </Field>
                <Field label="Output quantity" hint="Units the components below make"><Input name="outputQuantity" type="number" min="0.0001" step="any" defaultValue="1" /></Field>
                <Field label="Notes"><Input name="notes" /></Field>
              </div>
              <BomLineRows products={products} />
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search product…"
            filters={[{ name: "status", label: "Status", options: ["DRAFT", "ACTIVE", "ARCHIVED"].map((v) => ({ value: v, label: humanize(v) })) }]}
          />
          <RecordsTable
            columns={[
              { key: "product", label: "Product" },
              { key: "version", label: "Version" },
              { key: "lines", label: "Components" },
              { key: "orders", label: "Work orders" },
              { key: "created", label: "Created" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") || param(params, "status") ? "No bills of materials match your filters." : "No bills of materials yet."}
          >
            {page.items.length
              ? page.items.map((b) => (
                  <RecordsTableRow key={b.id}>
                    <RecordsTableCell>
                      <Link href={`/manufacturing/boms/${b.id}`} className="font-medium text-primary hover:underline">{b.product.sku} · {b.product.name}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>v{b.version}</RecordsTableCell>
                    <RecordsTableCell>{b._count.lines}</RecordsTableCell>
                    <RecordsTableCell>{b._count.workOrders}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(b.createdAt)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={b.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/manufacturing/boms" />
        </CardContent>
      </Card>
    </div>
  );
}
