import { can, getAccessContext } from "@/lib/access";
import { listCatalogLookups } from "@/features/catalog/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { formatQty } from "@/components/erp/format";

export default async function CatalogSettingsPage() {
  const ctx = await getAccessContext();
  const { uoms, categories, taxRates } = await listCatalogLookups(ctx);
  const canAdminister = can(ctx, "catalog.administer");

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Settings", "Catalog"]} title="Catalog" subtitle="Units of measure, product categories and GST rates used by products and documents." />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Units of measure</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {uoms.length === 0 ? <p className="text-sm text-muted">No units yet.</p> : null}
            <ul className="space-y-1 text-sm">
              {uoms.map((u) => (
                <li key={u.id}><strong>{u.code}</strong> <span className="text-muted">{u.name}</span></li>
              ))}
            </ul>
            {canAdminister ? (
              <ApiForm path="/uoms" submitLabel="Add unit" successMessage="Unit added" className="grid gap-3 sm:grid-cols-2">
                <Field label="Code"><Input name="code" required placeholder="NOS" /></Field>
                <Field label="Name"><Input name="name" required placeholder="Numbers" /></Field>
              </ApiForm>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Categories</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {categories.length === 0 ? <p className="text-sm text-muted">No categories yet.</p> : null}
            <ul className="space-y-1 text-sm">
              {categories.map((c) => <li key={c.id}>{c.name}</li>)}
            </ul>
            {canAdminister ? (
              <ApiForm path="/product-categories" submitLabel="Add category" successMessage="Category added">
                <Field label="Name"><Input name="name" required /></Field>
              </ApiForm>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Tax rates</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {taxRates.length === 0 ? <p className="text-sm text-muted">No tax rates yet.</p> : null}
            <ul className="space-y-2 text-sm">
              {taxRates.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  <span className="text-muted">{formatQty(t.rate)}%</span>
                  <Badge tone={t.isActive ? "success" : "neutral"}>{t.isActive ? "Active" : "Inactive"}</Badge>
                  {canAdminister ? (
                    <ActionButton
                      path={`/tax-rates/${t.id}`}
                      method="PATCH"
                      label={t.isActive ? "Deactivate" : "Activate"}
                      body={{ isActive: !t.isActive }}
                      variant="ghost"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
            {canAdminister ? (
              <ApiForm path="/tax-rates" submitLabel="Add tax rate" successMessage="Tax rate added" className="grid gap-3 sm:grid-cols-2">
                <Field label="Name"><Input name="name" required placeholder="GST 18%" /></Field>
                <Field label="Rate %"><Input name="rate" inputMode="decimal" required placeholder="18" /></Field>
              </ApiForm>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
