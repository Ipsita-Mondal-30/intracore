import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/erp/api-form";
import { humanize } from "@/components/erp/format";

type Defaults = { name?: string; channel?: string; templateId?: string; segmentId?: string; purpose?: string };

/** Shared create/edit fields for campaigns (rendered inside an ApiForm). */
export function CampaignFields({
  templates,
  segments,
  channels,
  defaults = {},
}: {
  templates: { id: string; name: string; channel: string; category: string }[];
  segments: { id: string; name: string; entity: string }[];
  channels: string[];
  defaults?: Defaults;
}) {
  return (
    <>
      <Field label="Name" className="sm:col-span-2"><Input name="name" required maxLength={200} defaultValue={defaults.name} /></Field>
      <Field label="Channel">
        <Select name="channel" required defaultValue={defaults.channel}>{channels.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select>
      </Field>
      <Field label="Template" hint="Must be for the same channel. Campaigns fill {{name}} per recipient.">
        <Select name="templateId" required defaultValue={defaults.templateId}>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {humanize(t.channel)} · {humanize(t.category)}</option>)}
        </Select>
      </Field>
      <Field label="Segment">
        <Select name="segmentId" required defaultValue={defaults.segmentId}>{segments.map((s) => <option key={s.id} value={s.id}>{s.name} ({humanize(s.entity)})</option>)}</Select>
      </Field>
      <Field label="Purpose" hint="Marketing needs an explicit opt-in; marketing templates are always marketing.">
        <Select name="purpose" defaultValue={defaults.purpose ?? ""}>
          <option value="">From the template</option>
          <option value="MARKETING">Marketing</option>
          <option value="TRANSACTIONAL">Transactional</option>
        </Select>
      </Field>
    </>
  );
}
