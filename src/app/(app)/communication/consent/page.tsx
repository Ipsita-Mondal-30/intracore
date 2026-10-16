import { CommunicationType } from "@prisma/client";
import { can, getAccessContext } from "@/lib/access";
import { CONSENT_STATUSES, listConsents, PURPOSES } from "@/features/communication/consent";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { ActionButton } from "@/components/erp/action-button";
import { ApiForm, Field } from "@/components/erp/api-form";
import { formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const channelOptions = Object.values(CommunicationType).map((c) => <option key={c} value={c}>{humanize(c)}</option>);

export default async function ConsentPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Communication", "Consent"]}
      title="Contact consent"
      subtitle="Marketing needs an opt-in; WhatsApp needs an opt-in for every business-initiated message; an opt-out always blocks. Replying STOP on WhatsApp opts out automatically."
    />
  );
  if (!can(ctx, "consent.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view consent records.</p></div>;
  }
  const p = listParams(params, ["channel", "purpose", "status"]);
  const page = await listConsents(ctx, {
    ...p,
    channel: p.channel && p.channel in CommunicationType ? p.channel : undefined,
    purpose: PURPOSES.includes(p.purpose as never) ? p.purpose : undefined,
    status: CONSENT_STATUSES.includes(p.status as never) ? p.status : undefined,
  });
  const manage = can(ctx, "consent.manage");

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search address…"
            filters={[
              { name: "channel", label: "Channel", options: Object.values(CommunicationType).map((c) => ({ value: c, label: humanize(c) })) },
              { name: "purpose", label: "Purpose", options: PURPOSES.map((s) => ({ value: s, label: humanize(s) })) },
              { name: "status", label: "Status", options: CONSENT_STATUSES.map((s) => ({ value: s, label: humanize(s) })) },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "address", label: "Address" },
              { key: "channel", label: "Channel" },
              { key: "purpose", label: "Purpose" },
              { key: "status", label: "Status" },
              { key: "source", label: "Source" },
              { key: "at", label: "Recorded" },
              { key: "actions", label: "" },
            ]}
            empty="No consent records."
          >
            {page.items.length
              ? page.items.map((c) => (
                  <RecordsTableRow key={c.id}>
                    <RecordsTableCell>{c.address}</RecordsTableCell>
                    <RecordsTableCell>{humanize(c.channel)}</RecordsTableCell>
                    <RecordsTableCell>{humanize(c.purpose)}</RecordsTableCell>
                    <RecordsTableCell><Badge tone={c.status === "OPTED_IN" ? "success" : "danger"}>{humanize(c.status)}</Badge></RecordsTableCell>
                    <RecordsTableCell>{c.source ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{formatDateTime(c.recordedAt)}</RecordsTableCell>
                    <RecordsTableCell>
                      {manage ? (
                        <ActionButton
                          method="PATCH"
                          path={`/consents/${c.id}`}
                          label={c.status === "OPTED_IN" ? "Opt out" : "Opt in"}
                          body={{ status: c.status === "OPTED_IN" ? "OPTED_OUT" : "OPTED_IN" }}
                          prompt="Source / evidence (e.g. signed form, phone call)"
                          promptField="source"
                          variant="ghost"
                        />
                      ) : null}
                    </RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/communication/consent" />
        </CardContent>
      </Card>
      {manage ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Record consent</CardTitle></CardHeader>
            <CardContent>
              <ApiForm path="/consents" submitLabel="Record" className="grid gap-3 sm:grid-cols-2">
                <Field label="Channel"><Select name="channel" required>{channelOptions}</Select></Field>
                <Field label="Address" hint="Email, or phone with country code"><Input name="address" required maxLength={320} /></Field>
                <Field label="Purpose"><Select name="purpose" required>{PURPOSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
                <Field label="Status"><Select name="status" required>{CONSENT_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
                <Field label="Source" hint="Where the consent came from" className="sm:col-span-2"><Input name="source" maxLength={100} /></Field>
              </ApiForm>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Opt out of everything</CardTitle></CardHeader>
            <CardContent>
              <ApiForm path="/consents/opt-out" submitLabel="Opt out" confirm="Opt this address out of all messages on this channel?" className="grid gap-3 sm:grid-cols-2">
                <Field label="Channel"><Select name="channel" required>{channelOptions}</Select></Field>
                <Field label="Address"><Input name="address" required maxLength={320} /></Field>
              </ApiForm>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
