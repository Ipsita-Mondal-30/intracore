import Link from "next/link";
import { format } from "date-fns";
import { requirePermission, hasPermission } from "@/lib/tenant";
import { listLeadEmails } from "@/features/leads/queries";
import { isResendConfigured } from "@/lib/email/config";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmailLogTable, RunRemindersButton } from "@/features/leads/email-history-view";

export default async function LeadEmailPage() {
  const tenant = await requirePermission("lead.view");
  const canEdit = hasPermission(tenant, "lead.edit");
  const configured = isResendConfigured();
  const emails = await listLeadEmails(tenant);

  const reminderCount = emails.filter((e) => {
    const meta = e.metadata as Record<string, unknown> | null;
    return meta?.kind === "follow_up_reminder";
  }).length;

  const manualCount = emails.length - reminderCount;

  return (
    <div>
      <PageHeader
        breadcrumbs={["Leads", "E-mail"]}
        title="E-mail"
        subtitle={format(new Date(), "dd MMM yyyy")}
        actions={
          <>
            {canEdit && configured ? <RunRemindersButton /> : null}
            <Link href="/leads/new">
              <Button type="button" size="sm">New lead</Button>
            </Link>
          </>
        }
      />

      <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-5">
            <p className="text-2xs text-subtle">Resend</p>
            <Badge tone={configured ? "success" : "danger"} className="mt-1">
              {configured ? "Connected" : "Not configured"}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-2xs text-subtle">Total logged</p>
            <p className="text-2xl font-semibold">{emails.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-2xs text-subtle">Due reminders</p>
            <p className="text-2xl font-semibold">{reminderCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-2xs text-subtle">Manual to leads</p>
            <p className="text-2xl font-semibold">{manualCount}</p>
          </CardContent>
        </Card>
      </section>

      {!configured ? (
        <Card className="mb-4">
          <CardContent className="pt-5 text-sm text-muted">
            Set <code className="text-xs">RESEND_API_KEY</code> and{" "}
            <code className="text-xs">RESEND_FROM_EMAIL</code> in your environment to enable
            sending. Due reminders (2h, 24h, 48h, 72h) are emailed to assignees automatically
            when the cron job runs, or use &quot;Send due reminders now&quot;.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Email history</CardTitle>
        </CardHeader>
        <CardContent>
          <EmailLogTable
            rows={emails.map((e) => ({
              ...e,
              occurredAt: e.occurredAt,
            }))}
          />
        </CardContent>
      </Card>

      {configured ? (
        <p className="mt-4 text-2xs text-subtle">
          Cron: <code>GET /api/cron/follow-up-reminders</code> with{" "}
          <code>Authorization: Bearer CRON_SECRET</code> — schedule hourly on Vercel or your host.
        </p>
      ) : null}
    </div>
  );
}
