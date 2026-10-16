import { CommunicationType, type MessageTemplate } from "@prisma/client";
import { TEMPLATE_CATEGORIES } from "@/features/communication/templates";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { humanize } from "@/components/erp/format";

/** Create form (no template) or edit form (PATCH; channel is fixed once created). */
export function TemplateFields({ template }: { template?: MessageTemplate }) {
  const t = template;
  return (
    <ApiForm
      path={t ? `/message-templates/${t.id}` : "/message-templates"}
      method={t ? "PATCH" : "POST"}
      submitLabel={t ? "Save template" : "Create template"}
      redirect={t ? undefined : "/communication/templates/:id"}
      className="grid gap-3 sm:grid-cols-3"
    >
      <Field label="Name"><Input name="name" required maxLength={100} defaultValue={t?.name} /></Field>
      {t ? null : (
        <Field label="Channel">
          <Select name="channel" required>{Object.values(CommunicationType).map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select>
        </Field>
      )}
      <Field label="Category" hint="Marketing needs explicit opt-in">
        <Select name="category" defaultValue={t?.category ?? "TRANSACTIONAL"}>{TEMPLATE_CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select>
      </Field>
      <Field label="Language" hint="e.g. en, en_US, hi"><Input name="language" defaultValue={t?.language ?? "en"} maxLength={10} /></Field>
      <Field label="Variables" hint="Comma-separated, in WhatsApp parameter order"><Input name="variables" defaultValue={t?.variables.join(", ")} /></Field>
      <Field label="WhatsApp template name" hint="Approved name in Meta (WhatsApp only)"><Input name="providerTemplateName" data-nullable defaultValue={t?.providerTemplateName ?? ""} maxLength={512} /></Field>
      <Field label="Subject" hint="Email only" className="sm:col-span-3"><Input name="subject" data-nullable defaultValue={t?.subject ?? ""} maxLength={300} /></Field>
      <Field label="Body" className="sm:col-span-3"><Textarea name="body" required rows={5} maxLength={4096} defaultValue={t?.body} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isActive" defaultChecked={t?.isActive ?? true} /> Active</label>
    </ApiForm>
  );
}
