import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listCustomers } from "@/features/customers/service";
import { OPEN_STAGES, listOpportunities } from "@/features/opportunities/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STAGES = [...OPEN_STAGES, "WON", "LOST"];

export default async function OpportunitiesPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const canCreate = can(ctx, "opportunity.create") && can(ctx, "customer.view");
  const [page, summary, customers] = await Promise.all([
    listOpportunities(ctx, listParams(params, ["stage", "open", "customerId"])),
    prisma.opportunity.groupBy({
      by: ["stage"],
      where: { organizationId: ctx.organizationId, stage: { in: OPEN_STAGES } },
      _count: true,
      _sum: { amount: true },
    }),
    canCreate ? listCustomers(ctx, { pageSize: "100" }) : null,
  ]);

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["CRM", "Opportunities"]} title="Opportunities" subtitle="Deals in your pipeline, from prospecting to won or lost." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {OPEN_STAGES.map((stage) => {
          const row = summary.find((s) => s.stage === stage);
          return (
            <Link key={stage} href={`/crm/opportunities?stage=${stage}`} className="ic-card block p-4 hover:border-primary/40">
              <p className="text-2xs text-subtle">{humanize(stage)}</p>
              <p className="text-lg font-semibold">{formatMoney(row?._sum.amount ?? 0)}</p>
              <p className="text-xs text-muted">{row?._count ?? 0} open</p>
            </Link>
          );
        })}
      </div>

      {canCreate && customers ? (
        <Card>
          <CardHeader><CardTitle>New opportunity</CardTitle></CardHeader>
          <CardContent>
            {customers.items.length === 0 ? (
              <p className="text-sm text-muted">
                Create a <Link href="/crm/customers" className="text-primary hover:underline">customer</Link> first.
              </p>
            ) : (
              <ApiForm path="/opportunities" submitLabel="Create opportunity" redirect="/crm/opportunities/:id" className="grid gap-3 sm:grid-cols-4">
                <Field label="Name"><Input name="name" required /></Field>
                <Field label="Customer">
                  <Select name="customerId" required defaultValue="">
                    <option value="" disabled>Select customer…</option>
                    {customers.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="Amount"><Input name="amount" inputMode="decimal" placeholder="0.00" /></Field>
                <Field label="Expected close"><Input type="date" name="expectedCloseDate" /></Field>
              </ApiForm>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search opportunities…"
            filters={[
              { name: "stage", label: "Stage", options: STAGES.map((v) => ({ value: v, label: humanize(v) })) },
              { name: "open", label: "State", options: [{ value: "true", label: "Open" }, { value: "false", label: "Closed" }] },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "name", label: "Opportunity" },
              { key: "customer", label: "Customer" },
              { key: "stage", label: "Stage" },
              { key: "amount", label: "Amount" },
              { key: "close", label: "Expected close" },
              { key: "owner", label: "Owner" },
            ]}
            empty={param(params, "q") || param(params, "stage") || param(params, "open") ? "No opportunities match these filters." : "No opportunities yet. Create one above or convert a lead."}
          >
            {page.items.length
              ? page.items.map((o) => (
                  <RecordsTableRow key={o.id}>
                    <RecordsTableCell>
                      <Link href={`/crm/opportunities/${o.id}`} className="font-medium text-primary hover:underline">{o.name}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>
                      <Link href={`/crm/customers/${o.customer.id}`} className="hover:underline">{o.customer.name}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={o.stage} /></RecordsTableCell>
                    <RecordsTableCell>{formatMoney(o.amount, o.currency)}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(o.expectedCloseDate)}</RecordsTableCell>
                    <RecordsTableCell>{o.owner?.name ?? o.owner?.email ?? "—"}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/crm/opportunities" />
        </CardContent>
      </Card>
    </div>
  );
}
