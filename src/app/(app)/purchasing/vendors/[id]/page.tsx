import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, companyScopeWhere, getAccessContext } from "@/lib/access";
import { getVendor } from "@/features/purchasing/vendors";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, formatMoney } from "@/components/erp/format";

export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const vendor = await getVendor(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const orders = can(ctx, "purchase_order.view")
    ? await prisma.purchaseOrder.findMany({ where: { AND: [companyScopeWhere(ctx), { vendorId: id }] }, orderBy: { createdAt: "desc" }, take: 20 })
    : null;
  const canEdit = can(ctx, "vendor.update");

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Purchasing", "Vendors", vendor.name]}
        title={vendor.name}
        subtitle={[vendor.code, vendor.legalName, vendor.gstin && `GSTIN ${vendor.gstin}`].filter(Boolean).join(" · ") || undefined}
        actions={
          <>
            <StatusBadge status={vendor.status} />
            {can(ctx, "purchase_order.create") && vendor.status === "ACTIVE" ? (
              <Link href={`/purchasing/orders/new?vendorId=${id}`} className="text-sm text-primary hover:underline">New purchase order</Link>
            ) : null}
            {can(ctx, "vendor.delete") && vendor.status !== "ARCHIVED" ? (
              <ActionButton path={`/vendors/${id}`} method="PATCH" label="Archive" body={{ status: "ARCHIVED" }} confirm="Archive this vendor?" variant="ghost" />
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              {canEdit ? (
                <ApiForm path={`/vendors/${id}`} method="PATCH" className="grid gap-3 sm:grid-cols-3">
                  <Field label="Name"><Input name="name" defaultValue={vendor.name} required /></Field>
                  <Field label="Code"><Input name="code" defaultValue={vendor.code ?? ""} data-nullable /></Field>
                  <Field label="Legal name"><Input name="legalName" defaultValue={vendor.legalName ?? ""} data-nullable /></Field>
                  <Field label="Email"><Input name="email" type="email" defaultValue={vendor.email ?? ""} data-nullable /></Field>
                  <Field label="Phone"><Input name="phone" defaultValue={vendor.phone ?? ""} data-nullable /></Field>
                  <Field label="GSTIN"><Input name="gstin" defaultValue={vendor.gstin ?? ""} data-nullable /></Field>
                  <Field label="PAN"><Input name="pan" defaultValue={vendor.pan ?? ""} data-nullable /></Field>
                  <Field label="State code"><Input name="stateCode" inputMode="numeric" pattern="[0-9]{2}" maxLength={2} defaultValue={vendor.stateCode ?? ""} data-nullable /></Field>
                  <Field label="Payment terms (days)"><Input type="number" min="0" max="365" name="paymentTermsDays" defaultValue={vendor.paymentTermsDays ?? ""} data-nullable /></Field>
                  <Field label="Status">
                    <Select name="status" defaultValue={vendor.status === "ARCHIVED" ? "" : vendor.status}>
                      {vendor.status === "ARCHIVED" ? <option value="">Archived</option> : null}
                      <option value="ACTIVE">Active</option>
                      <option value="INACTIVE">Inactive</option>
                    </Select>
                  </Field>
                  <Field label="Address" className="sm:col-span-3"><Input name="address" defaultValue={vendor.address ?? ""} data-nullable /></Field>
                  <Field label="Notes" className="sm:col-span-3"><Textarea name="notes" rows={3} defaultValue={vendor.notes ?? ""} data-nullable /></Field>
                </ApiForm>
              ) : (
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div><dt className="text-subtle">Email</dt><dd>{vendor.email ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Phone</dt><dd>{vendor.phone ?? "—"}</dd></div>
                  <div><dt className="text-subtle">PAN</dt><dd>{vendor.pan ?? "—"}</dd></div>
                  <div><dt className="text-subtle">State code</dt><dd>{vendor.stateCode ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Payment terms</dt><dd>{vendor.paymentTermsDays ?? "—"} days</dd></div>
                  <div><dt className="text-subtle">Address</dt><dd>{vendor.address ?? "—"}</dd></div>
                  {vendor.notes ? <div className="sm:col-span-2"><dt className="text-subtle">Notes</dt><dd className="whitespace-pre-line">{vendor.notes}</dd></div> : null}
                </dl>
              )}
            </CardContent>
          </Card>

          {orders ? (
            <Card>
              <CardHeader><CardTitle>Recent purchase orders</CardTitle></CardHeader>
              <CardContent>
                {orders.length === 0 ? <p className="text-sm text-muted">No purchase orders yet.</p> : null}
                <ul className="space-y-1 text-sm">
                  {orders.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-center gap-2">
                      <Link href={`/purchasing/orders/${o.id}`} className="text-primary hover:underline">{o.number}</Link>
                      <StatusBadge status={o.status} />
                      <span className="text-muted">{formatMoney(o.grandTotal, o.currency)}</span>
                      <span className="text-2xs text-subtle">{formatDate(o.orderDate)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Contacts</CardTitle></CardHeader>
            <CardContent>
              {vendor.contacts.length === 0 ? <p className="text-sm text-muted">No contacts.</p> : null}
              <ul className="space-y-2">
                {vendor.contacts.map((c) => (
                  <li key={c.id} className="rounded-xl bg-[var(--ic-surface-muted)] px-3 py-2 text-sm">
                    <span className="font-medium">{c.fullName}</span>
                    {c.isPrimary ? <span className="ml-2 text-2xs text-success">Primary</span> : null}
                    <p className="text-xs text-muted">{[c.jobTitle, c.email, c.phone].filter(Boolean).join(" · ")}</p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="vendor" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
