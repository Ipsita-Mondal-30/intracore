import { CommunicationType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { humanize } from "@/components/erp/format";

export default async function SendMessagePage() {
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Communication", "Message log", "Send"]}
      title="Send a message"
      subtitle="One-off transactional message from an active template. Consent is checked before sending; marketing goes through campaigns."
    />
  );
  if (!can(ctx, "communication.send")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to send messages.</p></div>;
  }
  const templates = await prisma.messageTemplate.findMany({
    where: { organizationId: ctx.organizationId, isActive: true, category: "TRANSACTIONAL" },
    orderBy: [{ channel: "asc" }, { name: "asc" }],
  });

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          {templates.length === 0 ? (
            <p className="text-sm text-muted">No active transactional templates. Create one under Templates first.</p>
          ) : (
            <ApiForm path="/communications" submitLabel="Queue message" successMessage="Message queued" redirect="/communication/messages/:id" className="grid gap-3 sm:grid-cols-2">
              <Field label="Channel">
                <Select name="channel" required>{Object.values(CommunicationType).map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select>
              </Field>
              <Field label="To" hint="Email address, or phone number with country code">
                <Input name="to" required maxLength={320} />
              </Field>
              <Field label="Template" className="sm:col-span-2">
                <Select name="templateId" required>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {humanize(t.channel)} · {t.name} ({t.language}){t.variables.length ? ` — needs ${t.variables.join(", ")}` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Variables (JSON)" hint='e.g. {"name": "Asha", "order": "SO-0001"}' className="sm:col-span-2">
                <Textarea name="variables" data-json rows={3} defaultValue="{}" />
              </Field>
            </ApiForm>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
