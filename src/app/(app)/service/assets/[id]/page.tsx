import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getAsset } from "@/features/service/assets";
import { CLAIM_REASONS, listClaims } from "@/features/service/claims";
import { memberOptions, userNames } from "@/features/service/lookups";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

const LIFECYCLE: Record<string, { action: string; label: string }[]> = {
  IN_STOCK: [{ action: "in-use", label: "Put in use" }, { action: "repair", label: "Send for repair" }, { action: "retire", label: "Retire" }],
  IN_USE: [{ action: "in-stock", label: "Return to stock" }, { action: "repair", label: "Send for repair" }, { action: "retire", label: "Retire" }],
  UNDER_REPAIR: [{ action: "in-use", label: "Back in use" }, { action: "in-stock", label: "Return to stock" }, { action: "retire", label: "Retire" }],
  RETIRED: [{ action: "dispose", label: "Dispose" }],
  DISPOSED: [],
};

const reasonText = (codes: string | null) =>
  codes?.split(",").map((c) => CLAIM_REASONS[c as keyof typeof CLAIM_REASONS] ?? c).join("; ") ?? "";

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "asset.view")) return <p className="text-sm text-muted">You don&apos;t have permission to view assets.</p>;
  const asset = await getAsset(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const canUpdate = can(ctx, "asset.update") && asset.status !== "DISPOSED";
  const [claims, members, names] = await Promise.all([
    can(ctx, "contract.view") ? listClaims(ctx, { assetId: id, pageSize: 50 }) : null,
    canUpdate ? memberOptions(ctx) : [],
    userNames([asset.assignedToId]),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Service", "Assets", asset.tag]}
        title={`${asset.tag} · ${asset.name}`}
        subtitle={[asset.product ? `${asset.product.sku} ${asset.product.name}` : null, asset.serialNumber ? `S/N ${asset.serialNumber}` : null, asset.customer?.name].filter(Boolean).join(" · ")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={asset.status} />
            {can(ctx, "asset.update") ? (LIFECYCLE[asset.status] ?? []).map((t) => <ActionButton key={t.action} path={`/assets/${id}/${t.action}`} label={t.label} confirm={`${t.label}?`} />) : null}
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Warranties</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {asset.warranties.length === 0 ? <p className="text-muted">No warranties recorded.</p> : (
                <ul className="space-y-1">
                  {asset.warranties.map((w) => (
                    <li key={w.id}>
                      <span className="font-medium">{humanize(w.type)}</span> {formatDate(w.startDate)} – {formatDate(w.endDate)}
                      <span className="text-subtle"> · {[w.coversParts && "parts", w.coversLabor && "labour"].filter(Boolean).join(" + ") || "no cover"}</span>
                      {w.terms ? <span className="block text-2xs text-subtle">{w.terms}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              {canUpdate ? (
                <ApiForm path="/warranties" extra={{ assetId: id }} submitLabel="Add warranty" className="grid gap-3 sm:grid-cols-3">
                  <Field label="Type"><Select name="type"><option value="STANDARD">Standard</option><option value="EXTENDED">Extended</option></Select></Field>
                  <Field label="Start"><Input type="date" name="startDate" required /></Field>
                  <Field label="End"><Input type="date" name="endDate" required /></Field>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="coversParts" defaultChecked /> Covers parts</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="coversLabor" defaultChecked /> Covers labour</label>
                  <Field label="Terms" className="sm:col-span-3"><Textarea name="terms" rows={2} /></Field>
                </ApiForm>
              ) : null}
            </CardContent>
          </Card>

          {claims ? (
            <Card>
              <CardHeader><CardTitle>Service claims</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {claims.items.length === 0 ? <p className="text-muted">No claims.</p> : (
                  <ul className="space-y-2">
                    {claims.items.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={c.status} />
                        <span className="font-medium">{humanize(c.serviceType)}</span>
                        <span className="text-subtle">{c.claimType}{c.contract ? ` · ${c.contract.number}` : ""} · {formatDate(c.createdAt)}</span>
                        {c.decisionReason ? <span className="w-full text-2xs text-subtle">{c.status === "REJECTED" && !c.decidedById ? "Not covered (chargeable): " : ""}{reasonText(c.decisionReason)}</span> : null}
                        {c.status === "PENDING" && can(ctx, "service.administer") ? (
                          <>
                            <ActionButton path={`/service-claims/${c.id}/approve`} label="Approve" variant="default" />
                            <ActionButton path={`/service-claims/${c.id}/reject`} label="Reject" variant="ghost" prompt="Reason for rejecting" />
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {can(ctx, "contract.update") && asset.status !== "DISPOSED" ? (
                  <ApiForm path="/service-claims" extra={{ assetId: id }} submitLabel="Check coverage and submit" className="grid gap-3 sm:grid-cols-3">
                    <Field label="Service type" hint="REPAIR / PARTS / LABOR for warranty; contract entitlement types for AMC"><Input name="serviceType" required maxLength={60} /></Field>
                    <Field label="Claim under"><Select name="claimType"><option value="">Warranty, else AMC</option><option value="WARRANTY">Warranty</option><option value="AMC">AMC</option></Select></Field>
                  </ApiForm>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {canUpdate ? (
            <Card>
              <CardHeader><CardTitle>Assignment and location</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path={`/assets/${id}`} method="PATCH" className="grid gap-3 sm:grid-cols-3">
                  <Field label="Name"><Input name="name" defaultValue={asset.name} maxLength={200} /></Field>
                  <Field label="Location"><Input name="location" defaultValue={asset.location ?? ""} data-nullable maxLength={500} /></Field>
                  <Field label="Assigned to">
                    <Select name="assignedToId" defaultValue={asset.assignedToId ?? ""} data-nullable>
                      <option value="">Unassigned</option>
                      {members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </Select>
                  </Field>
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
                <div><dt className="text-subtle">Ownership</dt><dd>{humanize(asset.ownership)}{asset.customer ? ` · ${asset.customer.name}` : ""}</dd></div>
                <div><dt className="text-subtle">Location</dt><dd>{asset.location ?? "—"}</dd></div>
                <div><dt className="text-subtle">Assigned to</dt><dd>{asset.assignedToId ? names.get(asset.assignedToId) ?? "—" : "—"}</dd></div>
                <div><dt className="text-subtle">Installed</dt><dd>{formatDate(asset.installDate) || "—"}</dd></div>
                {asset.value ? <div><dt className="text-subtle">Value</dt><dd>{formatMoney(asset.value)}</dd></div> : null}
                {asset.contracts.length ? (
                  <div>
                    <dt className="text-subtle">Contracts</dt>
                    <dd className="space-y-1">
                      {asset.contracts.map(({ contract: c }) => (
                        <Link key={c.id} href={`/service/contracts/${c.id}`} className="block text-primary hover:underline">{c.number} · {humanize(c.status)} · ends {formatDate(c.endDate)}</Link>
                      ))}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="asset" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
