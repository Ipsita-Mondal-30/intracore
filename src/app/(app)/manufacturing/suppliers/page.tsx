import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listSupplierEvaluations, procurementReport, QUALIFICATION_STATUSES } from "@/features/quality/suppliers";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ApiForm, Field } from "@/components/erp/api-form";
import { param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, formatQty, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const th = "py-2 pr-2";
const num = "py-2 pr-2 text-right";
const pct = (v: string | null) => (v === null ? "—" : `${v}%`);

export default async function SuppliersPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Manufacturing", "Supplier quality"]} title="Supplier quality" subtitle="Evaluations, qualification and procurement performance. Blocked vendors cannot receive new purchase orders." />;
  const canReport = can(ctx, "purchase_order.view");
  const canEvaluate = can(ctx, "supplier.evaluate");
  if (!canReport && !canEvaluate && !can(ctx, "vendor.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have access to supplier records.</p></div>;
  }
  const query = { companyId: param(params, "companyId") || undefined, from: param(params, "from") || undefined, to: param(params, "to") || undefined };
  const [report, evaluations, vendors, companies] = await Promise.all([
    canReport ? procurementReport(ctx, query) : [],
    canEvaluate || can(ctx, "vendor.view") ? listSupplierEvaluations(ctx, { pageSize: "20" }) : { items: [] },
    canEvaluate
      ? prisma.vendor.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { id: true, name: true, qualificationStatus: true }, orderBy: { name: "asc" }, take: 500 })
      : [],
    prisma.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } }, select: { id: true, code: true }, orderBy: { code: "asc" } }),
  ]);

  return (
    <div className="space-y-4">
      {header}

      {canReport ? (
        <Card>
          <CardHeader><CardTitle>Procurement performance</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <form method="get" className="flex flex-wrap items-end gap-2">
              <label className="text-sm">
                <span className="mb-1 block text-subtle">Company</span>
                <Select name="companyId" defaultValue={query.companyId ?? ""}>
                  <option value="">All</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
                </Select>
              </label>
              <label className="text-sm"><span className="mb-1 block text-subtle">Ordered from</span><Input name="from" type="date" defaultValue={query.from ?? ""} /></label>
              <label className="text-sm"><span className="mb-1 block text-subtle">to</span><Input name="to" type="date" defaultValue={query.to ?? ""} /></label>
              <Button type="submit" size="sm" variant="secondary">Apply</Button>
            </form>
            {report.length === 0 ? (
              <p className="text-sm text-muted">No approved purchase orders in this period.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                    <tr className="border-b border-[var(--ic-border)]">
                      <th className={th}>Vendor</th><th className={th}>Qualification</th><th className={num}>POs</th><th className={num}>Order value</th>
                      <th className={num}>On-time receipts</th><th className={num}>Avg lead time</th><th className={num}>Rejection rate</th><th className={num}>NCRs (open)</th><th className={th}>Last scores Q/D/P</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.map((r) => (
                      <tr key={r.vendor.id} className="border-b border-[var(--ic-border)] last:border-0">
                        <td className={th}><Link href={`/purchasing/vendors/${r.vendor.id}`} className="text-primary hover:underline">{r.vendor.name}</Link></td>
                        <td className={th}><StatusBadge status={r.vendor.qualificationStatus} /></td>
                        <td className={num}>{r.purchaseOrders}</td>
                        <td className={num}>{formatMoney(r.orderValue)}</td>
                        <td className={num}>{pct(r.onTimeReceiptPct)}</td>
                        <td className={num}>{r.avgLeadTimeDays === null ? "—" : `${r.avgLeadTimeDays} d`}</td>
                        <td className={num}>{pct(r.rejectionRatePct)}<span className="block text-2xs text-subtle">{formatQty(r.rejectedQty)} / {formatQty(r.inspectedQty)}</span></td>
                        <td className={num}>{r.nonConformances.total} ({r.nonConformances.open})</td>
                        <td className={th}>{r.latestEvaluation ? `${r.latestEvaluation.qualityScore}/${r.latestEvaluation.deliveryScore}/${r.latestEvaluation.priceScore}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {canEvaluate ? (
          <Card>
            <CardHeader><CardTitle>Evaluate a supplier</CardTitle></CardHeader>
            <CardContent>
              <ApiForm path="/supplier-evaluations" submitLabel="Save evaluation" successMessage="Evaluation saved">
                <Field label="Vendor">
                  <Select name="vendorId" required defaultValue="">
                    <option value="" disabled>Choose…</option>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.name} ({humanize(v.qualificationStatus)})</option>)}
                  </Select>
                </Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Quality (0–100)"><Input name="qualityScore" type="number" min="0" max="100" required /></Field>
                  <Field label="Delivery (0–100)"><Input name="deliveryScore" type="number" min="0" max="100" required /></Field>
                  <Field label="Price (0–100)"><Input name="priceScore" type="number" min="0" max="100" required /></Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Evaluated on"><Input name="evaluatedOn" type="date" /></Field>
                  <Field label="Set qualification">
                    <Select name="qualificationStatus" defaultValue="">
                      <option value="">Leave unchanged</option>
                      {QUALIFICATION_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                    </Select>
                  </Field>
                </div>
                <Field label="Notes"><Input name="notes" /></Field>
              </ApiForm>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader><CardTitle>Recent evaluations</CardTitle></CardHeader>
          <CardContent>
            {evaluations.items.length === 0 ? <p className="text-sm text-muted">No evaluations yet.</p> : null}
            <ul className="space-y-1 text-sm">
              {evaluations.items.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{e.vendor.name}</span>
                  <span className="text-muted">Q {e.qualityScore} · D {e.deliveryScore} · P {e.priceScore}</span>
                  <span className="text-2xs text-subtle">{formatDate(e.evaluatedOn)}</span>
                  {e.notes ? <span className="text-muted">— {e.notes}</span> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
