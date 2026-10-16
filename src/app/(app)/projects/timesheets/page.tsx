import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { CLOSED_PROJECT } from "@/features/projects/projects";
import { listTimeEntries } from "@/features/projects/time";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { param } from "@/components/erp/list-controls";
import { dateInput, formatQty } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const DAY = 86_400_000;
/** Monday (UTC) of the week containing `d`. */
const monday = (d: Date) => {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY);
};

export default async function TimesheetPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Projects", "My timesheet"]} title="My timesheet" subtitle="Time you logged this week. Max 24 hours per day." />;
  if (!can(ctx, "project.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view projects.</p></div>;
  }
  const requested = param(params, "week");
  const start = monday(requested && !Number.isNaN(Date.parse(requested)) ? new Date(requested) : new Date());
  const end = new Date(start.getTime() + 6 * DAY);
  const [entries, memberships] = await Promise.all([
    listTimeEntries(ctx, { mine: "true", from: dateInput(start), to: dateInput(end), pageSize: 100, sort: "date", dir: "asc" }),
    prisma.projectMember.findMany({
      where: { organizationId: ctx.organizationId, userId: ctx.userId, role: { not: "VIEWER" }, project: { status: { notIn: CLOSED_PROJECT }, companyId: { in: [...ctx.companies.keys()] } } },
      select: { project: { select: { id: true, code: true, name: true, billable: true } } },
      orderBy: { project: { code: "asc" } },
    }),
  ]);
  const days = Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * DAY));
  const byDay = (d: Date) => entries.items.filter((e) => dateInput(e.date) === dateInput(d));
  const sum = (xs: { hours: { toString(): string } }[]) => xs.reduce((s, e) => s + Number(e.hours.toString()), 0);
  const week = (offset: number) => `/projects/timesheets?week=${dateInput(new Date(start.getTime() + offset * 7 * DAY))}`;

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Week of {dateInput(start)} · {formatQty(entries.totalHours)} h</CardTitle>
            <nav className="flex gap-2 text-sm">
              <Link href={week(-1)} className="rounded-lg border border-[var(--ic-border)] px-3 py-1">Previous</Link>
              <Link href="/projects/timesheets" className="rounded-lg border border-[var(--ic-border)] px-3 py-1">This week</Link>
              <Link href={week(1)} className="rounded-lg border border-[var(--ic-border)] px-3 py-1">Next</Link>
            </nav>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-[var(--ic-border)] text-sm">
            {days.map((d) => {
              const items = byDay(d);
              return (
                <li key={d.toISOString()} className="py-2">
                  <p className="flex justify-between font-medium">
                    <span>{new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" }).format(d)}</span>
                    <span>{formatQty(sum(items))} h</span>
                  </p>
                  {items.map((e) => (
                    <div key={e.id} className="mt-1 flex flex-wrap items-center justify-between gap-2 pl-3 text-muted">
                      <span>
                        {formatQty(e.hours)} h · <Link href={`/projects/${e.projectId}`} className="text-primary hover:underline">{e.project.code}</Link>
                        {e.task ? ` · ${e.task.title}` : ""}{e.description ? ` · ${e.description}` : ""}
                      </span>
                      <span className="flex items-center gap-2">
                        {e.billable ? <Badge tone="primary">Billable</Badge> : null}
                        <ActionButton path={`/time-entries/${e.id}`} method="DELETE" label="Delete" variant="ghost" confirm="Delete this time entry?" />
                      </span>
                    </div>
                  ))}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Log time</CardTitle></CardHeader>
        <CardContent>
          {memberships.length === 0 ? (
            <p className="text-sm text-muted">You aren&apos;t a member of any open project.</p>
          ) : (
            <ApiForm path="/time-entries" submitLabel="Log time" className="grid gap-3 sm:grid-cols-4">
              <Field label="Project">
                <Select name="projectId" required>{memberships.map(({ project: p }) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select>
              </Field>
              <Field label="Date"><Input type="date" name="date" required defaultValue={dateInput(new Date())} /></Field>
              <Field label="Hours"><Input name="hours" required inputMode="decimal" placeholder="1.5" /></Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="billable" /> Billable</label>
              <Field label="Description" className="sm:col-span-4"><Input name="description" maxLength={2000} /></Field>
            </ApiForm>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
