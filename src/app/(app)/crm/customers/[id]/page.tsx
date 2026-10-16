import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, companyScopeWhere, getAccessContext } from "@/lib/access";
import { getCustomer, getTimeline } from "@/features/customers/service";
import { listCustomerPrices } from "@/features/catalog/service";
import { listOpportunities } from "@/features/opportunities/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, formatDateTime, formatMoney, humanize } from "@/components/erp/format";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const customer = await getCustomer(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const [timeline, opportunities, quotations, orders, prices, products] = await Promise.all([
    getTimeline(ctx, { customerId: id }),
    can(ctx, "opportunity.view") ? listOpportunities(ctx, { customerId: id, pageSize: "50" }) : null,
    can(ctx, "quotation.view")
      ? prisma.quotation.findMany({ where: { AND: [companyScopeWhere(ctx), { customerId: id, status: { not: "SUPERSEDED" } }] }, orderBy: { createdAt: "desc" }, take: 20 })
      : [],
    can(ctx, "sales_order.view")
      ? prisma.salesOrder.findMany({ where: { AND: [companyScopeWhere(ctx), { customerId: id }] }, orderBy: { createdAt: "desc" }, take: 20 })
      : [],
    listCustomerPrices(ctx, id),
    can(ctx, "customer.update") ? prisma.product.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { id: true, sku: true, name: true }, orderBy: { name: "asc" }, take: 500 }) : [],
  ]);
  const canEdit = can(ctx, "customer.update");

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["CRM", "Customers", customer.name]}
        title={customer.name}
        subtitle={[customer.legalName, customer.gstin && `GSTIN ${customer.gstin}`].filter(Boolean).join(" · ") || undefined}
        actions={
          <>
            <StatusBadge status={customer.status} />
            {can(ctx, "quotation.create") ? <Link href={`/sales/quotations/new?customerId=${id}`} className="text-sm text-primary hover:underline">New quotation</Link> : null}
            {can(ctx, "customer.delete") && customer.status !== "ARCHIVED" ? (
              <ActionButton path={`/customers/${id}`} method="PATCH" label="Archive" body={{ status: "ARCHIVED" }} confirm="Archive this customer?" variant="ghost" />
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
                <ApiForm path={`/customers/${id}`} method="PATCH" className="grid gap-3 sm:grid-cols-3">
                  <Field label="Name"><Input name="name" defaultValue={customer.name} /></Field>
                  <Field label="Legal name"><Input name="legalName" defaultValue={customer.legalName ?? ""} data-nullable /></Field>
                  <Field label="Email"><Input name="email" defaultValue={customer.email ?? ""} data-nullable /></Field>
                  <Field label="Phone"><Input name="phone" defaultValue={customer.phone ?? ""} data-nullable /></Field>
                  <Field label="GSTIN"><Input name="gstin" defaultValue={customer.gstin ?? ""} data-nullable /></Field>
                  <Field label="State code"><Input name="stateCode" defaultValue={customer.stateCode ?? ""} data-nullable /></Field>
                  <Field label="Payment terms (days)"><Input type="number" name="paymentTermsDays" defaultValue={customer.paymentTermsDays ?? ""} data-nullable /></Field>
                  <Field label="Credit limit"><Input name="creditLimit" defaultValue={customer.creditLimit?.toString() ?? ""} data-nullable /></Field>
                  <Field label="Website"><Input name="website" defaultValue={customer.website ?? ""} data-nullable /></Field>
                  <Field label="Billing address" className="sm:col-span-3"><Input name="billingAddress" defaultValue={customer.billingAddress ?? ""} data-nullable /></Field>
                  <Field label="Shipping address" className="sm:col-span-3"><Input name="shippingAddress" defaultValue={customer.shippingAddress ?? ""} data-nullable /></Field>
                </ApiForm>
              ) : (
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div><dt className="text-subtle">Email</dt><dd>{customer.email ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Phone</dt><dd>{customer.phone ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Billing address</dt><dd>{customer.billingAddress ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Payment terms</dt><dd>{customer.paymentTermsDays ?? "—"} days</dd></div>
                </dl>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Contacts</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {customer.contacts.length === 0 ? <p className="text-sm text-muted">No contacts yet.</p> : null}
              <ul className="grid gap-2 sm:grid-cols-2">
                {customer.contacts.map((c) => (
                  <li key={c.id} className="rounded-xl bg-[var(--ic-surface-muted)] px-3 py-2 text-sm">
                    <Link href={`/crm/contacts/${c.id}`} className="font-medium text-primary hover:underline">{c.fullName}</Link>
                    {c.isPrimary ? <span className="ml-2 text-2xs text-success">Primary</span> : null}
                    <p className="text-xs text-muted">{[c.jobTitle, c.email, c.phone].filter(Boolean).join(" · ")}</p>
                  </li>
                ))}
              </ul>
              {can(ctx, "contact.create") ? (
                <ApiForm path="/contacts" submitLabel="Add contact" extra={{ customerId: id }} successMessage="Contact added" className="grid gap-3 sm:grid-cols-4">
                  <Field label="First name"><Input name="firstName" required /></Field>
                  <Field label="Last name"><Input name="lastName" /></Field>
                  <Field label="Email"><Input name="email" type="email" /></Field>
                  <Field label="Phone"><Input name="phone" /></Field>
                </ApiForm>
              ) : null}
            </CardContent>
          </Card>

          {opportunities ? (
            <Card>
              <CardHeader><CardTitle>Opportunities</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {opportunities.items.length === 0 ? <p className="text-sm text-muted">No opportunities yet.</p> : null}
                <ul className="space-y-1 text-sm">
                  {opportunities.items.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-center gap-2">
                      <Link href={`/crm/opportunities/${o.id}`} className="font-medium text-primary hover:underline">{o.name}</Link>
                      <StatusBadge status={o.stage} />
                      <span className="text-muted">{formatMoney(o.amount, o.currency)}</span>
                      <span className="text-2xs text-subtle">close {formatDate(o.expectedCloseDate)}</span>
                    </li>
                  ))}
                </ul>
                {can(ctx, "opportunity.create") ? (
                  <ApiForm path="/opportunities" submitLabel="Add opportunity" extra={{ customerId: id }} successMessage="Opportunity added" className="grid gap-3 sm:grid-cols-3">
                    <Field label="Name"><Input name="name" required /></Field>
                    <Field label="Amount"><Input name="amount" inputMode="decimal" placeholder="0.00" /></Field>
                    <Field label="Expected close"><Input type="date" name="expectedCloseDate" /></Field>
                  </ApiForm>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader><CardTitle>Quotations & orders</CardTitle></CardHeader>
            <CardContent>
              {quotations.length + orders.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : null}
              <ul className="space-y-1 text-sm">
                {quotations.map((q) => (
                  <li key={q.id} className="flex items-center gap-2">
                    <Link href={`/sales/quotations/${q.id}`} className="text-primary hover:underline">{q.number}{q.revision > 1 ? ` R${q.revision}` : ""}</Link>
                    <StatusBadge status={q.status} /> <span className="text-muted">{formatMoney(q.grandTotal, q.currency)}</span>
                  </li>
                ))}
                {orders.map((o) => (
                  <li key={o.id} className="flex items-center gap-2">
                    <Link href={`/sales/orders/${o.id}`} className="text-primary hover:underline">{o.number}</Link>
                    <StatusBadge status={o.status} /> <span className="text-muted">{formatMoney(o.grandTotal, o.currency)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Customer prices</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {prices.length === 0 ? <p className="text-sm text-muted">Uses list prices. Add a negotiated price below.</p> : null}
              <ul className="space-y-1 text-sm">
                {prices.map((p) => (
                  <li key={p.id} className="flex items-center gap-2">
                    {p.product.sku} · {p.product.name}: <strong>{formatMoney(p.unitPrice)}</strong>
                    <span className="text-2xs text-subtle">list {formatMoney(p.product.salesPrice)}</span>
                    {canEdit ? <ActionButton path={`/customers/${id}/prices`} method="PUT" label="Remove" variant="ghost" body={{ prices: [{ productId: p.productId, unitPrice: null }] }} /> : null}
                  </li>
                ))}
              </ul>
              {canEdit && products.length ? (
                <PriceForm customerId={id} products={products} />
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {can(ctx, "activity.create") ? (
            <Card>
              <CardHeader><CardTitle>Log interaction</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path="/activities" extra={{ customerId: id }} submitLabel="Log" successMessage="Logged">
                  <Field label="Type">
                    <Select name="type" defaultValue="CALL">
                      {["CALL", "EMAIL", "MEETING", "NOTE"].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                    </Select>
                  </Field>
                  <Field label="Subject"><Input name="subject" required /></Field>
                  <Field label="Details"><Textarea name="body" rows={3} /></Field>
                  <Field label="When"><Input type="datetime-local" name="occurredAt" /></Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
            <CardContent>
              {timeline.length === 0 ? <p className="text-sm text-muted">No interactions yet.</p> : null}
              <ol className="space-y-3">
                {timeline.map((e) => (
                  <li key={`${e.source}-${e.id}`} className="text-sm">
                    <p className="text-2xs text-subtle">{formatDateTime(e.occurredAt)} · {humanize(e.type)}{e.source === "lead" ? " (lead)" : ""}</p>
                    <p className="font-medium">{e.subject}</p>
                    {e.body ? <p className="whitespace-pre-line text-muted">{e.body}</p> : null}
                    {e.actor ? <p className="text-2xs text-subtle">by {e.actor.name}</p> : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="customer" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function PriceForm({ customerId, products }: { customerId: string; products: { id: string; sku: string; name: string }[] }) {
  return (
    <ApiForm path={`/customers/${customerId}/prices`} method="PUT" submitLabel="Set price" successMessage="Price saved" className="flex flex-wrap items-end gap-2">
      <Field label="Product">
        <Select name="prices.0.productId" required>
          {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
        </Select>
      </Field>
      <Field label="Unit price"><Input name="prices.0.unitPrice" inputMode="decimal" required /></Field>
    </ApiForm>
  );
}
