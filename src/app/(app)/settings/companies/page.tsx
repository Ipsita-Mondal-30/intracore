import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listCompanies, listNumberSequences } from "@/features/companies/service";
import { ScopeEditor } from "@/features/companies/scope-editor";
import { ApiForm, Field } from "@/components/erp/api-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export default async function CompaniesSettingsPage() {
  const ctx = await getAccessContext();
  const companies = await listCompanies(ctx);
  const canCreate = can(ctx, "company.create");
  const canUpdate = can(ctx, "company.update");
  const canAdminister = can(ctx, "company.administer");
  const fullAccess = companies.filter((c) => ctx.companies.get(c.id) === "all");
  const sequences = canAdminister
    ? Object.fromEntries(
        await Promise.all(fullAccess.map(async (c) => [c.id, await listNumberSequences(ctx, c.id)] as const)),
      )
    : {};
  const members = canAdminister
    ? await prisma.organizationMember.findMany({
        where: { organizationId: ctx.organizationId, isOwner: false, status: "ACTIVE" },
        include: { user: { select: { name: true, email: true } }, role: { select: { name: true } }, scopes: true },
        orderBy: { joinedAt: "asc" },
      })
    : [];

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Settings", "Companies"]}
        title="Companies & branches"
        subtitle="Legal entities, GST registrations, document numbering and who can access them."
      />

      {canCreate ? (
        <Card>
          <CardHeader><CardTitle>New company</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/companies" submitLabel="Create company" successMessage="Company created" className="grid gap-3 sm:grid-cols-3">
              <Field label="Code"><Input name="code" required placeholder="e.g. ACME-KA" /></Field>
              <Field label="Name"><Input name="name" required /></Field>
              <Field label="Legal name"><Input name="legalName" /></Field>
              <Field label="PAN"><Input name="pan" placeholder="AAAAA1111A" /></Field>
              <Field label="GSTIN"><Input name="gstin" placeholder="29AAAAA1111A1Z5" /></Field>
              <Field label="State code" hint="2-digit GST state code"><Input name="stateCode" placeholder="29" /></Field>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}

      {companies.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted">You do not have access to any company yet.</CardContent></Card>
      ) : null}

      {companies.map((company) => {
        const full = ctx.companies.get(company.id) === "all";
        return (
          <Card key={company.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {company.name}
                <Badge tone="neutral">{company.code}</Badge>
                {company.isDefault ? <Badge tone="primary">Default</Badge> : null}
                {company.gstin ? <Badge tone="success">GSTIN {company.gstin}</Badge> : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {canUpdate && full ? (
                <ApiForm path={`/companies/${company.id}`} method="PATCH" className="grid gap-3 sm:grid-cols-3">
                  <Field label="Name"><Input name="name" defaultValue={company.name} /></Field>
                  <Field label="Legal name"><Input name="legalName" defaultValue={company.legalName ?? ""} data-nullable /></Field>
                  <Field label="PAN"><Input name="pan" defaultValue={company.pan ?? ""} data-nullable /></Field>
                  <Field label="GSTIN"><Input name="gstin" defaultValue={company.gstin ?? ""} data-nullable /></Field>
                  <Field label="State code"><Input name="stateCode" defaultValue={company.stateCode ?? ""} data-nullable /></Field>
                  <Field label="Address"><Input name="address" defaultValue={company.address ?? ""} data-nullable /></Field>
                </ApiForm>
              ) : null}

              {canAdminister && full ? (
                <div>
                  <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">Policies</p>
                  <ApiForm path={`/companies/${company.id}`} method="PATCH" successMessage="Policies saved" className="grid gap-3 sm:grid-cols-4">
                    <Field label="Quote discount needing approval (%)">
                      <Input type="number" step="0.01" name="settings.quotation.approvalDiscountPercent" defaultValue={company.settings.quotation.approvalDiscountPercent} />
                    </Field>
                    <Field label="Quote total needing approval" hint="Blank = no value limit">
                      <Input type="number" step="0.01" name="settings.quotation.approvalAmount" defaultValue={company.settings.quotation.approvalAmount ?? ""} data-nullable />
                    </Field>
                    <Field label="PO total needing approval" hint="Blank = auto-approve">
                      <Input type="number" step="0.01" name="settings.purchase.approvalAmount" defaultValue={company.settings.purchase.approvalAmount ?? ""} data-nullable />
                    </Field>
                    <Field label="Allow negative stock">
                      <input type="checkbox" name="settings.inventory.allowNegativeStock" defaultChecked={company.settings.inventory.allowNegativeStock} />
                    </Field>
                  </ApiForm>
                </div>
              ) : null}

              <div>
                <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">Branches</p>
                <ul className="grid gap-2">
                  {company.branches.map((branch) => (
                    <li key={branch.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--ic-surface-muted)] px-3 py-2 text-sm">
                      <Badge tone="neutral">{branch.code}</Badge>
                      {branch.name}
                      {branch.gstin ? <span className="text-2xs text-subtle">GSTIN {branch.gstin}</span> : null}
                      {!branch.isActive ? <Badge tone="warning">Inactive</Badge> : null}
                    </li>
                  ))}
                </ul>
                {canUpdate && full ? (
                  <ApiForm path={`/companies/${company.id}/branches`} submitLabel="Add branch" successMessage="Branch added" className="mt-3 grid gap-3 sm:grid-cols-4">
                    <Field label="Code"><Input name="code" required /></Field>
                    <Field label="Name"><Input name="name" required /></Field>
                    <Field label="GSTIN" hint="Only if registered separately"><Input name="gstin" /></Field>
                    <Field label="State code"><Input name="stateCode" /></Field>
                  </ApiForm>
                ) : null}
              </div>

              {sequences[company.id] ? (
                <div>
                  <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">Document numbering</p>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {sequences[company.id].map((seq) => (
                      <ApiForm key={seq.documentType} path={`/companies/${company.id}/number-sequences/${seq.documentType}`} method="PATCH" className="rounded-xl border border-[var(--ic-border)] p-3" submitLabel="Update">
                        <p className="text-xs font-semibold">{seq.documentType.replace(/_/g, " ")}</p>
                        <div className="flex gap-2">
                          <Input name="prefix" defaultValue={seq.prefix} className="h-8" aria-label="Prefix" />
                          <Input type="number" name="nextNumber" defaultValue={seq.nextNumber} min={seq.nextNumber} className="h-8 w-24" aria-label="Next number" />
                        </div>
                      </ApiForm>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}

      {canAdminister && members.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>Member access</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted">Members only see companies and branches ticked here. Owners always see everything.</p>
            {members.map((member) => (
              <div key={member.id} className="rounded-xl border border-[var(--ic-border)] p-3">
                <p className="mb-2 text-sm font-medium">
                  {member.user.name ?? member.user.email} <span className="text-2xs text-subtle">· {member.role.name}</span>
                </p>
                <ScopeEditor
                  memberId={member.id}
                  companies={fullAccess.map((c) => ({ id: c.id, code: c.code, branches: c.branches }))}
                  initial={member.scopes
                    .filter((s) => ctx.companies.get(s.companyId) === "all")
                    .map((s) => ({ companyId: s.companyId, branchId: s.branchId }))}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
