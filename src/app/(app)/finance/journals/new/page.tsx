import { can, getAccessContext } from "@/lib/access";
import { listCompanies } from "@/features/companies/service";
import { listAccounts } from "@/features/finance/setup";
import { JournalForm } from "@/features/finance/journal-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { param } from "@/components/erp/list-controls";
import { dateInput } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NewJournalPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Finance", "Journals", "New"]} title="New journal" subtitle="Saved as a draft. Post it once debits equal credits." />;
  const message = (text: string) => (
    <div className="space-y-4">
      {header}
      <Card><CardContent className="pt-5 text-sm text-muted">{text}</CardContent></Card>
    </div>
  );
  if (!can(ctx, "finance.post")) return message("You need the finance post permission to create journals.");

  // Journals need full company access and finance set up.
  const companies = (can(ctx, "company.view") ? await listCompanies(ctx) : []).filter((c) => ctx.companies.get(c.id) === "all" && c.settings.finance.enabled);
  if (companies.length === 0) return message("No company you can post to has finance set up yet. Set it up under Finance → Setup.");
  const company = companies.find((c) => c.id === param(params, "companyId")) ?? companies[0];
  const { accounts } = await listAccounts(ctx, company.id);
  const options = accounts.filter((a) => a.isActive && !a.isGroup).map((a) => ({ id: a.id, code: a.code, name: a.name }));

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardHeader>
          <CardTitle>{company.code} · {company.name}</CardTitle>
          {companies.length > 1 ? (
            <form method="get" className="flex items-center gap-2">
              <Select name="companyId" defaultValue={company.id} aria-label="Company" className="w-auto">
                {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </Select>
              <Button type="submit" size="sm" variant="secondary">Switch</Button>
            </form>
          ) : null}
        </CardHeader>
        <CardContent>
          {options.length < 2 ? (
            <p className="text-sm text-muted">This company needs at least two active posting accounts.</p>
          ) : (
            <JournalForm key={company.id} companyId={company.id} accounts={options} defaultDate={dateInput(new Date())} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
