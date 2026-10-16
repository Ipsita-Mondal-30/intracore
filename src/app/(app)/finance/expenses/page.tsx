import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listExpenseClaims } from "@/features/finance/expenses";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { Pagination, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";
import { cn } from "@/lib/utils";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "PAID", "CANCELLED"];

export default async function ExpensesPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Finance", "Expenses"]}
      title="Expense claims"
      subtitle="Employee reimbursements: submit, approve, pay."
      actions={can(ctx, "expense.create") ? <Link href="/finance/expenses/new" className="text-sm text-primary hover:underline">New claim</Link> : null}
    />
  );
  if (!can(ctx, "expense.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view expense claims.</p></div>;
  }

  const canSeeAll = can(ctx, "expense.approve") || can(ctx, "expense.pay");
  const view = canSeeAll && param(params, "view") === "all" ? "all" : "mine";
  const status = param(params, "status") ?? "";
  const page = await listExpenseClaims(ctx, {
    mine: view === "mine" ? "true" : undefined,
    status: STATUSES.includes(status) ? status : undefined,
    page: param(params, "page"),
  });
  const tabHref = (v: string) => `/finance/expenses?view=${v}${status ? `&status=${status}` : ""}`;

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            {canSeeAll ? (
              <nav className="flex gap-4 border-b border-[var(--ic-border)] text-sm">
                {[["mine", "My claims"], ["all", "All claims"]].map(([v, label]) => (
                  <Link key={v} href={tabHref(v)} className={cn("-mb-px border-b-2 pb-2", view === v ? "border-primary font-medium text-foreground" : "border-transparent text-muted")}>
                    {label}
                  </Link>
                ))}
              </nav>
            ) : <span />}
            <form method="get" className="flex items-center gap-2">
              <input type="hidden" name="view" value={view} />
              <Select name="status" defaultValue={status} className="max-w-[200px]" aria-label="Status">
                <option value="">Status: all</option>
                {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </Select>
              <Button type="submit" size="sm" variant="secondary">Apply</Button>
            </form>
          </div>
          <RecordsTable
            columns={[
              { key: "number", label: "Claim" },
              { key: "title", label: "Title" },
              ...(view === "all" ? [{ key: "claimant", label: "Claimant" }] : []),
              { key: "created", label: "Created" },
              { key: "total", label: "Total" },
              { key: "status", label: "Status" },
            ]}
            empty={view === "mine" ? "You have no expense claims yet." : "No expense claims match."}
          >
            {page.items.length
              ? page.items.map((c) => (
                  <RecordsTableRow key={c.id}>
                    <RecordsTableCell>
                      <Link href={`/finance/expenses/${c.id}`} className="font-medium text-primary hover:underline">{c.number}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{c.title}</RecordsTableCell>
                    {view === "all" ? <RecordsTableCell>{c.claimant.name ?? c.claimant.email}</RecordsTableCell> : null}
                    <RecordsTableCell>{formatDate(c.createdAt)}</RecordsTableCell>
                    <RecordsTableCell>{formatMoney(c.totalAmount)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={c.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={{ ...params, view }} basePath="/finance/expenses" />
        </CardContent>
      </Card>
    </div>
  );
}
