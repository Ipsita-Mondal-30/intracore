import { can, getAccessContext } from "@/lib/access";
import { listIntegrations } from "@/features/integrations/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/components/erp/action-button";
import { ApiForm, Field } from "@/components/erp/api-form";
import { formatDateTime, humanize } from "@/components/erp/format";

const TONE = { CONNECTED: "success", ERROR: "danger", DISCONNECTED: "neutral" } as const;

export default async function IntegrationsSettingsPage() {
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Settings", "Integrations"]}
      title="Integrations"
      subtitle="Message providers for this organization. One provider is enabled per channel. Secrets are stored encrypted and can only be replaced, never viewed."
    />
  );
  if (!can(ctx, "integration.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view integrations.</p></div>;
  }
  const integrations = await listIntegrations(ctx);
  const manage = can(ctx, "integration.manage");
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";

  return (
    <div className="space-y-4">
      {header}
      <div className="grid gap-4 xl:grid-cols-2">
        {integrations.map((i) => (
          <Card key={i.provider}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {i.label}
                <Badge tone={TONE[i.status]}>{i.status === "CONNECTED" ? "Enabled" : i.status === "ERROR" ? "Enabled · check failed" : "Disabled"}</Badge>
                {i.mock ? <Badge tone="warning">Simulated — never sends</Badge> : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted">
                Channel: {i.channel ? humanize(i.channel) : "E-signature"} · Last check: {formatDateTime(i.lastCheckedAt)}
              </p>
              {i.lastError ? <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-danger">{i.lastError}</p> : null}
              {i.webhookPath ? (
                <p className="text-xs text-muted">
                  Webhook callback URL (Meta → WhatsApp → Configuration): <code className="break-all">{site}{i.webhookPath}</code>. Use the verify token saved below and subscribe to the <code>messages</code> field.
                </p>
              ) : null}
              {manage && (i.fields.secrets.length || i.fields.config.length) ? (
                <ApiForm path={`/integrations/${i.provider}`} method="PUT" submitLabel="Save settings" className="grid gap-3 sm:grid-cols-2">
                  {i.fields.config.map((f) => (
                    <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`} hint={f.hint}>
                      <Input name={`config.${f.key}`} defaultValue={i.config[f.key] ?? ""} required={f.required} />
                    </Field>
                  ))}
                  {i.fields.secrets.map((f) => (
                    <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}${i.secretsConfigured[f.key] ? " — configured ✓" : ""}`} hint={f.hint}>
                      <Input
                        type="password"
                        name={`secrets.${f.key}`}
                        autoComplete="new-password"
                        placeholder={i.secretsConfigured[f.key] ? "Leave blank to keep the saved value" : ""}
                        required={f.required && !i.secretsConfigured[f.key]}
                      />
                    </Field>
                  ))}
                </ApiForm>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {!i.enabled && can(ctx, "integration.connect") ? <ActionButton path={`/integrations/${i.provider}/connect`} label="Enable" variant="default" /> : null}
                {i.enabled && can(ctx, "integration.disconnect") ? <ActionButton path={`/integrations/${i.provider}/disconnect`} label="Disable" confirm="Disable this provider? Messages on this channel will fail as not configured." /> : null}
                {manage && i.id ? <ActionButton path={`/integrations/${i.provider}/check`} label="Test connection" variant="ghost" /> : null}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
