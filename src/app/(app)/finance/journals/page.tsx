import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listJournals } from "@/features/finance/journals";
import { listCompanies } from "@/features/companies/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUSES = ["DRAFT", "POSTED", "REVERSED"];
const SOURCES = ["MANUAL", "SALES_INVOICE", "CREDIT_NOTE", "RECEIPT", "VENDOR_BILL", "DEBIT_NOTE", "VENDOR_PAYMENT", "STOCK_ENTRY", "EXPENSE_CLAIM", "TRANSFER"];

export default async function JournalsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  if (!can(ctx, "finance.view")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["Finance", "Journals"]} title="Journals" />
        <Card><CardContent className="pt-5 text-sm text-muted">You don&apos;t have access to finance. Ask an administrator for the finance view permission.</CardContent></Card>
      </div>
    );
  }

  const companies = can(ctx, "company.view") ? await listCompanies(ctx) : [];
  const companyCode = new Map(companies.map((c) => [c.id, c.code]));
  const page = await listJournals(ctx, listParams(params, ["companyId", "status", "sourceType", "from", "to"]));
  const filtered = ["q", "companyId", "status", "sourceType", "from", "to"].some((k) => param(params, k));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Journals"]}
        title="Journals"
        subtitle="Every ledger posting. Documents post their own journals; manual journals are for adjustments and opening balances."
        actions={can(ctx, "finance.post") ? <Link href="/finance/journals/new" className="text-sm font-medium text-primary hover:underline">New journal</Link> : null}
      />

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number or memo…"
            filters={[
              ...(companies.length > 1 ? [{ name: "companyId", label: "Company", options: companies.map((c) => ({ value: c.id, label: c.code })) }] : []),
              { name: "status", label: "Status", options: STATUSES.map((v) => ({ value: v, label: humanize(v) })) },
              { name: "sourceType", label: "Source", options: SOURCES.map((v) => ({ value: v, label: humanize(v) })) },
            ]}
          >
            <Input type="date" name="from" defaultValue={param(params, "from") ?? ""} aria-label="From" className="w-auto" />
            <Input type="date" name="to" defaultValue={param(params, "to") ?? ""} aria-label="To" className="w-auto" />
          </ListToolbar>
          <RecordsTable
            columns={[
              { key: "number", label: "Number" },
              { key: "date", label: "Date" },
              { key: "company", label: "Company" },
              { key: "memo", label: "Memo" },
              { key: "source", label: "Source" },
              { key: "total", label: "Amount", className: "text-right" },
              { key: "status", label: "Status" },
            ]}
            empty={filtered ? "No journals match your filters." : "No journals yet."}
          >
            {page.items.length
              ? page.items.map((j) => (
                  <RecordsTableRow key={j.id}>
                    <RecordsTableCell>
                      <Link href={`/finance/journals/${j.id}`} className="font-medium text-primary hover:underline">{j.number ?? "Draft"}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{formatDate(j.date)}</RecordsTableCell>
                    <RecordsTableCell>{companyCode.get(j.companyId) ?? "—"}</RecordsTableCell>
                    <RecordsTableCell className="max-w-xs truncate">{j.memo ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{humanize(j.sourceType)}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatMoney(j.totalDebit)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={j.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination page={page.page} pageSize={page.pageSize} total={page.total} params={params} basePath="/finance/journals" />
        </CardContent>
      </Card>
    </div>
  );
}
