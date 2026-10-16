import { Suspense } from "react";
import { format } from "date-fns";
import { Download } from "lucide-react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { requirePermission } from "@/lib/tenant";
import { prisma } from "@/lib/db/prisma";
import {
  EMPTY_DASHBOARD_STATS,
  getCachedLeadDashboardCharts,
  getCachedLeadDashboardStats,
} from "@/features/leads/queries";
import { DashboardCharts } from "@/features/leads/dashboard-charts";
import { isAppError } from "@/lib/errors";
import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/layout/kpi-card";
import { PerformanceGaugeCard } from "@/components/layout/performance-gauge-card";
import { DataTable } from "@/components/layout/data-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { perfTime } from "@/lib/perf";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function DashboardPage() {
  const pageTimer = perfTime("dashboard.page");
  let tenant;
  try {
    tenant = await requirePermission("dashboard.view");
  } catch (error) {
    if (isAppError(error) && error.code === "UNAUTHORIZED") {
      redirect("/login");
    }
    if (isAppError(error) && error.code === "NO_ORGANIZATION") {
      redirect("/onboarding/organization");
    }
    console.error("Dashboard auth failed", error);
    redirect("/auth/session-error");
  }

  let memberCount = 0;
  let stats = EMPTY_DASHBOARD_STATS;
  let recentLeads: {
    id: string;
    fullName: string;
    sourceName: string;
    assignedName: string;
    value: string;
    createdAt: Date;
  }[] = [];

  const dataTimer = perfTime("dashboard.prisma");
  try {
    const [memberCountResult, statsResult, leads] = await Promise.all([
      prisma.organizationMember.count({
        where: { organizationId: tenant.organizationId, status: "ACTIVE" },
      }),
      getCachedLeadDashboardStats(tenant.organizationId, tenant.userId),
      prisma.lead.findMany({
        where: { organizationId: tenant.organizationId, archivedAt: null },
        select: {
          id: true,
          fullName: true,
          expectedValue: true,
          createdAt: true,
          source: { select: { name: true } },
          assignedUser: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);
    memberCount = memberCountResult;
    stats = statsResult;
    recentLeads = leads.map((lead) => ({
      id: lead.id,
      fullName: lead.fullName,
      sourceName: lead.source?.name ?? "—",
      assignedName: lead.assignedUser?.name ?? "—",
      value: lead.expectedValue?.toString() ?? "—",
      createdAt: lead.createdAt,
    }));
  } catch (error) {
    console.error("Dashboard data failed", error);
  }
  dataTimer.end();

  const today = format(new Date(), "dd MMM yyyy");
  const kpis = [
    { label: "Total leads", value: stats.total, highlighted: false },
    { label: "New leads", value: stats.newLeads, highlighted: true },
    { label: "Assigned to me", value: stats.assignedToMe },
    { label: "Contacted", value: stats.contacted },
    { label: "Qualified", value: stats.qualified },
    { label: "Follow-ups due", value: stats.followUpsDue },
    { label: "Overdue follow-ups", value: stats.overdueFollowUps },
    { label: "Converted", value: stats.converted },
    { label: "Lost leads", value: stats.lost },
    {
      label: "Pipeline value",
      value: `${tenant.organizationCurrency} ${stats.pipelineValue}`,
    },
  ];

  pageTimer.end();

  return (
    <div>
      <PageHeader
        breadcrumbs={["Overview", "Lead Management"]}
        title="Lead Management"
        subtitle={`${today} · ${tenant.organizationName} · ${memberCount} members · Conversion ${stats.conversionRate}%`}
        actions={
          <Link href="/leads">
            <Button type="button" variant="secondary" size="sm">
              <Download className="h-3.5 w-3.5" />
              Open leads
            </Button>
          </Link>
        }
      />

      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {kpis.map((kpi) => (
          <KpiCard
            key={kpi.label}
            label={kpi.label}
            value={kpi.value}
            highlighted={kpi.highlighted}
            delta={stats.total === 0 ? "No lead data yet" : undefined}
            deltaTone="neutral"
          />
        ))}
      </section>

      <section className="mb-6">
        <Suspense fallback={<div className="ic-card h-[280px] animate-pulse bg-[var(--ic-surface-muted)]" />}>
          <DashboardChartsLoader organizationId={tenant.organizationId} />
        </Suspense>
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Lead Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={["Name", "Source", "Assigned", "Value", "Date"]}
              empty="No leads yet."
            >
              {recentLeads.length
                ? recentLeads.map((lead) => (
                    <tr
                      key={lead.id}
                      className="border-b border-[var(--ic-border)] last:border-0"
                    >
                      <td className="px-3 py-3">
                        <Link href={`/leads/${lead.id}`} className="font-medium">
                          {lead.fullName}
                        </Link>
                      </td>
                      <td className="px-3 py-3">{lead.sourceName}</td>
                      <td className="px-3 py-3">{lead.assignedName}</td>
                      <td className="px-3 py-3">{lead.value}</td>
                      <td className="px-3 py-3 text-muted">
                        {format(lead.createdAt, "dd MMM yyyy")}
                      </td>
                    </tr>
                  ))
                : null}
            </DataTable>
          </CardContent>
        </Card>
        <PerformanceGaugeCard
          name={tenant.userName ?? undefined}
          pendingLabel="Pending follow-ups"
          pendingValue={String(stats.followUpsDue)}
          lostLabel="Lost leads"
          lostValue={String(stats.lost)}
        />
      </section>
    </div>
  );
}

async function DashboardChartsLoader({ organizationId }: { organizationId: string }) {
  const charts = await getCachedLeadDashboardCharts(organizationId);
  return (
    <DashboardCharts
      bySource={charts.bySource}
      byStage={charts.byStage}
      overTime={charts.overTime}
      byAssignee={charts.byAssignee}
    />
  );
}
