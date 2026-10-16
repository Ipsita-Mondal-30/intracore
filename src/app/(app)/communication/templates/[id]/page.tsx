import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getTemplate } from "@/features/communication/templates";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { humanize } from "@/components/erp/format";
import { TemplateFields } from "../template-fields";

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "communication.view")) notFound();
  const t = await getTemplate(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Communication", "Templates", t.name]}
        title={t.name}
        subtitle={`${humanize(t.channel)} · ${humanize(t.category)} · ${t.language}`}
        actions={t.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}
      />
      <Card>
        <CardContent className="pt-5">
          {can(ctx, "communication.administer") ? (
            <TemplateFields template={t} />
          ) : (
            <div className="space-y-2 text-sm">
              {t.subject ? <p className="font-medium">{t.subject}</p> : null}
              <p className="whitespace-pre-line">{t.body}</p>
              <p className="text-muted">Variables: {t.variables.join(", ") || "none"}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
