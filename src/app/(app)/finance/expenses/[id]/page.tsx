import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getExpenseClaim, listExpenseCategories } from "@/features/finance/expenses";
import { listDocuments } from "@/features/documents/service";
import { ExpenseClaimForm } from "@/features/finance/expense-claim-form";
import { DocumentDownload, DocumentUpload } from "@/features/finance/document-upload";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { dateInput, formatDate, formatDateTime, formatMoney } from "@/components/erp/format";

export default async function ExpenseClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "expense.view")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["Finance", "Expenses"]} title="Expense claim" />
        <p className="text-sm text-muted">You don&apos;t have permission to view expense claims.</p>
      </div>
    );
  }
  const claim = await getExpenseClaim(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = claim.status;
  const isClaimant = claim.claimantId === ctx.userId;
  const canEdit = isClaimant && (s === "DRAFT" || s === "REJECTED");
  const canPay = s === "APPROVED" && can(ctx, "expense.pay");

  const [categories, bankAccounts, documents, approver] = await Promise.all([
    canEdit ? listExpenseCategories(ctx, claim.companyId) : [],
    canPay
      ? prisma.bankAccount.findMany({ where: { organizationId: ctx.organizationId, companyId: claim.companyId, isActive: true }, select: { id: true, name: true, kind: true }, orderBy: { name: "asc" } })
      : [],
    can(ctx, "document.view") ? listDocuments(ctx, "expense_claim", id) : null,
    claim.approvedById ? prisma.user.findUnique({ where: { id: claim.approvedById }, select: { name: true, email: true } }) : null,
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Expenses", claim.number]}
        title={claim.title}
        subtitle={`${claim.number} · ${claim.claimant.name ?? claim.claimant.email} · ${formatMoney(claim.totalAmount)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            {isClaimant && s === "DRAFT" ? (
              <ActionButton path={`/expense-claims/${id}/submit`} label="Submit" variant="default" confirm="Submit this claim for approval?" />
            ) : null}
            {!isClaimant && s === "SUBMITTED" && can(ctx, "expense.approve") ? (
              <>
                <ActionButton path={`/expense-claims/${id}/approve`} label="Approve" variant="default" confirm="Approve this claim?" />
                <ActionButton path={`/expense-claims/${id}/reject`} label="Reject" variant="ghost" prompt="Reason for rejecting" promptField="reason" />
              </>
            ) : null}
            {isClaimant && (s === "DRAFT" || s === "SUBMITTED") ? (
              <ActionButton path={`/expense-claims/${id}/cancel`} label="Withdraw" variant="ghost" confirm="Withdraw this claim? It will be cancelled." />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {s === "REJECTED" && claim.rejectionReason ? (
            <Card>
              <CardContent className="pt-5 text-sm">
                <p className="font-medium text-danger">Rejected</p>
                <p className="whitespace-pre-line text-muted">{claim.rejectionReason}</p>
                {isClaimant ? <p className="mt-1 text-2xs text-subtle">Edit the claim below; saving returns it to draft so you can resubmit.</p> : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader><CardTitle>{canEdit ? "Edit expenses" : "Expenses"}</CardTitle></CardHeader>
            <CardContent>
              {canEdit ? (
                <ExpenseClaimForm
                  companies={[]}
                  categories={categories.filter((c) => c.isActive).map((c) => ({ id: c.id, companyId: c.companyId, name: c.name }))}
                  today={dateInput(new Date())}
                  initial={{
                    id,
                    companyId: claim.companyId,
                    title: claim.title,
                    lines: claim.lines.map((l) => ({
                      categoryId: l.categoryId,
                      expenseDate: dateInput(l.expenseDate),
                      description: l.description,
                      amount: l.amount.toString(),
                      taxAmount: l.taxAmount.toString(),
                    })),
                  }}
                />
              ) : claim.lines.length === 0 ? (
                <p className="text-sm text-muted">No expenses.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                      <tr className="border-b border-[var(--ic-border)]">
                        <th className="py-2 pr-2">Date</th>
                        <th className="py-2 pr-2">Category</th>
                        <th className="py-2 pr-2">Description</th>
                        <th className="py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {claim.lines.map((l) => (
                        <tr key={l.id} className="border-b border-[var(--ic-border)] last:border-0">
                          <td className="py-2 pr-2">{formatDate(l.expenseDate)}</td>
                          <td className="py-2 pr-2">{l.category.name}</td>
                          <td className="py-2 pr-2">{l.description}</td>
                          <td className="py-2 text-right">
                            {formatMoney(l.amount)}
                            {Number(l.taxAmount.toString()) > 0 ? <span className="block text-2xs text-subtle">incl. tax {formatMoney(l.taxAmount)}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-3 text-right text-base font-semibold">Total {formatMoney(claim.totalAmount)}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {canPay ? (
            <Card>
              <CardHeader><CardTitle>Pay claim</CardTitle></CardHeader>
              <CardContent>
                {bankAccounts.length === 0 ? (
                  <p className="text-sm text-muted">No active bank or cash accounts in this company. Add one under Finance › Setup.</p>
                ) : (
                  <ApiForm path={`/expense-claims/${id}/pay`} submitLabel={`Pay ${formatMoney(claim.totalAmount)}`} successMessage="Claim paid" confirm="Record this reimbursement as paid?" className="grid gap-3 sm:grid-cols-3">
                    <Field label="Paid from">
                      <Select name="bankAccountId" required>
                        {bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.name}{b.kind === "CASH" ? " (cash)" : ""}</option>)}
                      </Select>
                    </Field>
                    <Field label="Paid on"><Input type="date" name="paidOn" defaultValue={dateInput(new Date())} /></Field>
                    <Field label="Reference"><Input name="reference" maxLength={120} /></Field>
                  </ApiForm>
                )}
              </CardContent>
            </Card>
          ) : null}

          {documents ? (
            <Card>
              <CardHeader><CardTitle>Receipts</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {documents.length === 0 ? (
                  <p className="text-sm text-muted">No receipts attached.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {documents.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-baseline gap-2">
                        <DocumentDownload id={d.id} label={d.fileName} />
                        <span className="text-2xs text-subtle">{Math.ceil(d.sizeBytes / 1024)} KB · {formatDateTime(d.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {can(ctx, "document.create") && s !== "CANCELLED" ? <DocumentUpload entityType="expense_claim" entityId={id} /> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">Claimant</dt><dd>{claim.claimant.name ?? claim.claimant.email}</dd></div>
                <div><dt className="text-subtle">Created</dt><dd>{formatDateTime(claim.createdAt)}</dd></div>
                {claim.submittedAt ? <div><dt className="text-subtle">Submitted</dt><dd>{formatDateTime(claim.submittedAt)}</dd></div> : null}
                {claim.approvedAt ? (
                  <div><dt className="text-subtle">Approved</dt><dd>by {approver?.name ?? approver?.email ?? "—"} on {formatDateTime(claim.approvedAt)}</dd></div>
                ) : null}
                {claim.paidAt ? (
                  <div>
                    <dt className="text-subtle">Paid</dt>
                    <dd>{formatDate(claim.paidAt)} · {claim.bankAccount?.name ?? "—"}{claim.paymentReference ? ` · ${claim.paymentReference}` : ""}</dd>
                  </div>
                ) : null}
                {claim.approvalJournalId ? (
                  <div><dt className="text-subtle">Approval journal</dt><dd><Link href={`/finance/journals/${claim.approvalJournalId}`} className="text-primary hover:underline">View journal</Link></dd></div>
                ) : null}
                {claim.paymentJournalId ? (
                  <div><dt className="text-subtle">Payment journal</dt><dd><Link href={`/finance/journals/${claim.paymentJournalId}`} className="text-primary hover:underline">View journal</Link></dd></div>
                ) : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="expense_claim" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
