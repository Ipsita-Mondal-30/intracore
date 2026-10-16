import { can, getAccessContext } from "@/lib/access";
import { BATCH_LIMIT, listRetentionPolicies, previewRetention } from "@/features/admin/retention";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { param } from "@/components/erp/list-controls";
import { formatDateTime } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function RetentionPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Settings", "Data retention"]}
      title="Data retention"
      subtitle={`Purge operational history after a retention period. Only the record types below can be purged; financial records, stock moves and journals never are. Each run removes at most ${BATCH_LIMIT.toLocaleString("en-IN")} rows per type, oldest first.`}
      actions={can(ctx, "retention.manage") ? <ActionButton path="/admin/retention/run" label="Run enabled policies now" confirm="Purge rows past their retention period now?" /> : undefined}
    />
  );
  if (!can(ctx, "retention.manage")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to manage data retention.</p></div>;
  }
  const targets = await listRetentionPolicies(ctx);
  const previewTarget = param(params, "preview");
  const preview = previewTarget && targets.some((t) => t.target === previewTarget)
    ? await previewRetention(ctx, previewTarget, { keepDays: param(params, "keepDays") }).catch(() => null)
    : null;

  return (
    <div className="space-y-4">
      {header}
      {targets.map((t) => {
        const editable = !t.ownerOnly || ctx.isOwner;
        return (
          <Card key={t.target}>
            <CardHeader>
              <div>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {t.label}
                  <Badge tone={t.policy?.isEnabled ? "success" : "neutral"}>{t.policy?.isEnabled ? `Keep ${t.policy.keepDays} days` : "Not enabled"}</Badge>
                  {t.ownerOnly ? <Badge tone="warning">Owners only · archived first</Badge> : null}
                </CardTitle>
                <p className="mt-1 text-xs text-muted">{t.rule}. Minimum {t.minKeepDays} days.</p>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {t.policy ? (
                <p className="text-xs text-subtle">Last run {formatDateTime(t.policy.lastRunAt)} · purged {t.policy.lastPurged ?? 0}</p>
              ) : null}
              {editable ? (
                <ApiForm path={`/admin/retention/${t.target}`} method="PUT" submitLabel="Save policy" className="flex flex-wrap items-end gap-3 space-y-0">
                  <Field label="Keep (days)"><Input name="keepDays" type="number" min={t.minKeepDays} max={3650} required defaultValue={t.policy?.keepDays ?? t.minKeepDays} /></Field>
                  <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="isEnabled" defaultChecked={t.policy?.isEnabled ?? false} /> Enabled</label>
                </ApiForm>
              ) : (
                <p className="text-xs text-muted">Only an organization owner can change this policy.</p>
              )}
              <form method="get" className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="preview" value={t.target} />
                <Input name="keepDays" type="number" min={t.minKeepDays} defaultValue={t.policy?.keepDays ?? t.minKeepDays} className="max-w-[140px]" aria-label="Days to keep" />
                <Button type="submit" size="sm" variant="secondary">Dry run</Button>
                {preview && preview.target === t.target ? (
                  <span className="text-sm">
                    {preview.count.toLocaleString("en-IN")} rows older than {formatDateTime(preview.cutoff)} would be purged ({preview.thisRun.toLocaleString("en-IN")} in the next run).
                  </span>
                ) : null}
              </form>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
