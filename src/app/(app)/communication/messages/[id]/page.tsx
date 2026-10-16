import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getMessage } from "@/features/communication/messages";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime, humanize } from "@/components/erp/format";

export default async function MessagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "communication.view")) notFound();
  const m = await getMessage(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const rows: [string, React.ReactNode][] = [
    ["Direction", humanize(m.direction)],
    ["To", m.toAddress],
    ["From", m.fromAddress ?? "—"],
    ["Provider", m.provider],
    ["Provider message id", m.providerMessageId ?? "—"],
    ["Template", m.template ? `${m.template.name}${m.template.providerTemplateName ? ` (${m.template.providerTemplateName})` : ""}` : "—"],
    ["Linked record", m.entityType ? `${m.entityType} ${m.entityId}` : "—"],
    ["Attempts", m.attempts],
    ["Created", formatDateTime(m.createdAt)],
    ["Sent", formatDateTime(m.sentAt)],
    ["Delivered", formatDateTime(m.deliveredAt)],
    ["Read", formatDateTime(m.readAt)],
    ["Failed", formatDateTime(m.failedAt)],
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Communication", "Message log", humanize(m.channel)]}
        title={m.subject ?? `${humanize(m.channel)} message`}
        actions={<div className="flex items-center gap-2"><StatusBadge status={m.status} />{m.simulated ? <Badge tone="warning">Simulated</Badge> : null}</div>}
      />
      {m.simulated ? (
        <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning">Simulated: a mock provider handled this message. Nothing was sent to the recipient.</p>
      ) : null}
      {m.error ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">{m.error}</p> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardContent className="whitespace-pre-line pt-5 text-sm">{m.body}</CardContent></Card>
        <Card>
          <CardContent className="pt-5">
            <dl className="space-y-2 text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-muted">{k}</dt>
                  <dd className="break-all text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
