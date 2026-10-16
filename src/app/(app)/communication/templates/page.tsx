import Link from "next/link";
import { CommunicationType } from "@prisma/client";
import { can, getAccessContext } from "@/lib/access";
import { listTemplates, TEMPLATE_CATEGORIES } from "@/features/communication/templates";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { humanize } from "@/components/erp/format";
import { TemplateFields } from "./template-fields";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function TemplatesPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Communication", "Templates"]}
      title="Message templates"
      subtitle="Use {{variable}} placeholders and declare every variable. WhatsApp templates must match a template approved in Meta Business Manager."
    />
  );
  if (!can(ctx, "communication.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view templates.</p></div>;
  }
  const p = listParams(params, ["channel", "category"]);
  const page = await listTemplates(ctx, {
    ...p,
    channel: p.channel && p.channel in CommunicationType ? p.channel : undefined,
    category: TEMPLATE_CATEGORIES.includes(p.category as never) ? p.category : undefined,
  });

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search name…"
            filters={[
              { name: "channel", label: "Channel", options: Object.values(CommunicationType).map((c) => ({ value: c, label: humanize(c) })) },
              { name: "category", label: "Category", options: TEMPLATE_CATEGORIES.map((c) => ({ value: c, label: humanize(c) })) },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "name", label: "Name" },
              { key: "channel", label: "Channel" },
              { key: "category", label: "Category" },
              { key: "language", label: "Language" },
              { key: "variables", label: "Variables" },
              { key: "active", label: "Status" },
            ]}
            empty="No templates yet."
          >
            {page.items.length
              ? page.items.map((t) => (
                  <RecordsTableRow key={t.id}>
                    <RecordsTableCell><Link href={`/communication/templates/${t.id}`} className="font-medium text-primary hover:underline">{t.name}</Link></RecordsTableCell>
                    <RecordsTableCell>{humanize(t.channel)}</RecordsTableCell>
                    <RecordsTableCell>{humanize(t.category)}</RecordsTableCell>
                    <RecordsTableCell>{t.language}</RecordsTableCell>
                    <RecordsTableCell>{t.variables.join(", ") || "—"}</RecordsTableCell>
                    <RecordsTableCell>{t.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/communication/templates" />
        </CardContent>
      </Card>
      {can(ctx, "communication.administer") ? (
        <Card>
          <CardHeader><CardTitle>New template</CardTitle></CardHeader>
          <CardContent>
            <TemplateFields />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
