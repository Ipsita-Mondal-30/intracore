import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getContract } from "@/features/service/contracts";
import { listClaims } from "@/features/service/claims";
import { ContractForm } from "@/features/service/forms";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { dateInput, formatDate, formatMoney, humanize } from "@/components/erp/format";

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "contract.view")) return <p className="text-sm text-muted">You don&apos;t have permission to view contracts.</p>;
  const c = await getContract(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const canUpdate = can(ctx, "contract.update");
  const canQuote = canUpdate && can(ctx, "quotation.create") && (c.status === "ACTIVE" || c.status === "EXPIRED") && !c.renewalQuotationId;
  const [claims, branches, customerAssets] = await Promise.all([
    listClaims(ctx, { contractId: id, pageSize: 50 }),
    canQuote ? prisma.branch.findMany({ where: { companyId: c.companyId }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }) : [],
    canUpdate && c.status === "DRAFT"
      ? prisma.asset.findMany({ where: { organizationId: ctx.organizationId, customerId: c.customerId, status: { notIn: ["RETIRED", "DISPOSED"] } }, select: { id: true, tag: true, name: true, customerId: true }, orderBy: { tag: "asc" } })
      : [],
  ]);
  const scopedBranches = branches.filter((b) => {
    const scope = ctx.companies.get(c.companyId);
    return scope === "all" || scope?.has(b.id);
  });

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Service", "AMC contracts", c.number]}
        title={`${c.number} · ${c.customer.name}`}
        subtitle={`${formatDate(c.startDate)} – ${formatDate(c.endDate)} · ${formatMoney(c.value)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} />
            {canUpdate && c.status === "DRAFT" ? <ActionButton path={`/service-contracts/${id}/activate`} label="Activate" variant="default" confirm="Activate this contract?" /> : null}
            {canUpdate && c.status === "ACTIVE" ? <ActionButton path={`/service-contracts/${id}/expire`} label="Mark expired" confirm="Mark this contract expired?" /> : null}
            {canUpdate && (c.status === "DRAFT" || c.status === "ACTIVE") ? <ActionButton path={`/service-contracts/${id}/cancel`} label="Cancel" variant="ghost" prompt="Reason for cancelling" /> : null}
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {canUpdate && c.status === "DRAFT" ? (
            <Card>
              <CardHeader><CardTitle>Edit draft</CardTitle></CardHeader>
              <CardContent>
                <ContractForm
                  companies={[]}
                  customers={[]}
                  assets={customerAssets.map((a) => ({ id: a.id, label: `${a.tag} · ${a.name}`, customerId: a.customerId }))}
                  initial={{
                    id,
                    customerId: c.customerId,
                    startDate: dateInput(c.startDate),
                    endDate: dateInput(c.endDate),
                    value: c.value.toString(),
                    terms: c.terms ?? "",
                    assetIds: c.assets.map((a) => a.assetId),
                    entitlements: c.entitlements.map((e) => ({ serviceType: e.serviceType, quantity: e.quantity?.toString() ?? "" })),
                  }}
                />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader><CardTitle>Coverage</CardTitle></CardHeader>
              <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <p className="mb-1 font-medium">Covered assets</p>
                  <ul className="space-y-1">
                    {c.assets.map(({ asset: a }) => (
                      <li key={a.id}><Link href={`/service/assets/${a.id}`} className="text-primary hover:underline">{a.tag}</Link> {a.name}{a.serialNumber ? ` · S/N ${a.serialNumber}` : ""}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mb-1 font-medium">Entitlements</p>
                  <ul className="space-y-1">
                    {c.entitlements.map((e) => (
                      <li key={e.id}>{humanize(e.serviceType)}: {e.usedCount} used of {e.quantity ?? "unlimited"}</li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Claims</CardTitle></CardHeader>
            <CardContent className="text-sm">
              {claims.items.length === 0 ? <p className="text-muted">No claims against this contract.</p> : (
                <ul className="space-y-1">
                  {claims.items.map((cl) => (
                    <li key={cl.id} className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={cl.status} /> {humanize(cl.serviceType)} · <Link href={`/service/assets/${cl.asset.id}`} className="text-primary hover:underline">{cl.asset.tag}</Link> · {formatDate(cl.createdAt)}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {canQuote ? (
            <Card>
              <CardHeader><CardTitle>Renewal</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path={`/service-contracts/${id}/renewal-quotation`} submitLabel="Create renewal quotation" redirect="/sales/quotations/:id" className="grid gap-3 sm:grid-cols-2">
                  <Field label="Branch"><Select name="branchId" required>{scopedBranches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</Select></Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : null}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">Customer</dt><dd>{c.customer.name}</dd></div>
                {c.renewalOf ? <div><dt className="text-subtle">Renews</dt><dd><Link href={`/service/contracts/${c.renewalOf.id}`} className="text-primary hover:underline">{c.renewalOf.number}</Link></dd></div> : null}
                {c.renewals.map((r) => <div key={r.id}><dt className="text-subtle">Renewed by</dt><dd><Link href={`/service/contracts/${r.id}`} className="text-primary hover:underline">{r.number}</Link> ({humanize(r.status)})</dd></div>)}
                {c.renewalQuotationId ? <div><dt className="text-subtle">Renewal quotation</dt><dd><Link href={`/sales/quotations/${c.renewalQuotationId}`} className="text-primary hover:underline">View quotation</Link></dd></div> : null}
                {c.terms ? <div><dt className="text-subtle">Terms</dt><dd className="whitespace-pre-line">{c.terms}</dd></div> : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="service_contract" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
