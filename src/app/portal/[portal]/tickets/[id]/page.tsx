import { getTicket } from "@/features/portal/customer";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/erp/api-form";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime, humanize } from "@/components/erp/format";
import { orNotFound, pagePortal, PortalHeader, salesKind, Section } from "@/app/portal/_components/portal-page";
import { PortalForm } from "@/app/portal/_components/portal-client";
import { portalTitle, salesLinks } from "../../nav";

export default async function PortalTicket({ params }: { params: Promise<{ portal: string; id: string }> }) {
  const { portal, id } = await params;
  const p = await pagePortal(salesKind(portal));
  const t = await orNotFound(getTicket(p, id));
  const resolved = t.status === "RESOLVED" || t.status === "CLOSED";
  return (
    <div>
      <PortalHeader title={portalTitle(portal)} organization={p.organizationName} links={salesLinks(portal)} />
      <Section title={`${t.number} · ${t.subject}`}>
        <div className="mb-3 flex flex-wrap gap-3 text-sm">
          <StatusBadge status={t.status} />
          <span>{humanize(t.priority)} priority</span>
          {t.asset ? <span>{t.asset.tag} · {t.asset.name}</span> : null}
          {t.resolutionCode ? <span>Resolution: {humanize(t.resolutionCode)}</span> : null}
        </div>
        {t.description ? <p className="mb-4 whitespace-pre-wrap text-sm">{t.description}</p> : null}
        <ul className="space-y-2">
          {t.messages.map((m) => (
            <li key={m.id} className={`rounded-xl p-3 text-sm ${m.authorType === "CUSTOMER" ? "ml-8 bg-[var(--ic-table-header)]" : "mr-8 border border-[var(--ic-border)]"}`}>
              <p className="mb-1 text-2xs text-subtle">{m.authorType === "CUSTOMER" ? "You" : m.authorType === "SYSTEM" ? "System" : "Support"} · {formatDateTime(m.createdAt)}</p>
              <p className="whitespace-pre-wrap">{m.body}</p>
            </li>
          ))}
        </ul>
      </Section>
      {t.status !== "CLOSED" && t.status !== "CANCELLED" ? (
        <Section title="Reply">
          <PortalForm path={`/${portal}/tickets/${t.id}/reply`} submitLabel="Send" successMessage="Reply sent">
            <Textarea name="body" rows={3} required maxLength={20000} />
          </PortalForm>
        </Section>
      ) : null}
      {resolved && t.feedbackRating === null ? (
        <Section title="How did we do?">
          <PortalForm path={`/${portal}/tickets/${t.id}/feedback`} submitLabel="Send feedback" successMessage="Thank you">
            <Field label="Rating">
              <Select name="rating" defaultValue="5">{[5, 4, 3, 2, 1].map((r) => <option key={r} value={r}>{r}</option>)}</Select>
            </Field>
            <Field label="Comment"><Input name="comment" maxLength={2000} /></Field>
          </PortalForm>
        </Section>
      ) : t.feedbackRating ? <p className="text-sm text-muted">Your rating: {t.feedbackRating}/5{t.feedbackComment ? ` · ${t.feedbackComment}` : ""}</p> : null}
    </div>
  );
}
