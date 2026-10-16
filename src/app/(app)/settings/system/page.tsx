import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { getEnvironmentStatus, getOrgSettings } from "@/features/admin/settings";
import { OrgSettingsForm } from "@/features/admin/org-settings-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const LINKS: { href: string; label: string; note: string; permission: string }[] = [
  { href: "/settings/users", label: "Users", note: "Members, roles, suspension", permission: "member.view" },
  { href: "/settings/roles", label: "Roles & permissions", note: "Custom roles and the permission matrix", permission: "role.view" },
  { href: "/settings/companies", label: "Companies & branches", note: "GSTIN, numbering, settings, member scopes", permission: "company.view" },
  { href: "/settings/integrations", label: "Integrations", note: "Email, SMS and WhatsApp providers", permission: "integration.view" },
  { href: "/settings/audit", label: "Audit trail", note: "Search every recorded change", permission: "audit.view" },
  { href: "/settings/imports", label: "Imports", note: "CSV import of customers, contacts, vendors, products", permission: "data.import" },
  { href: "/settings/exports", label: "Exports", note: "Report exports (same access rules as the UI)", permission: "data.export" },
  { href: "/settings/retention", label: "Data retention", note: "Purge and archive policies", permission: "retention.manage" },
  { href: "/settings/backups", label: "Backups", note: "Backup runs, restore drills and procedure", permission: "backup.view" },
  { href: "/settings/jobs", label: "Jobs & webhooks", note: "Background queue and scheduler runs", permission: "job.view" },
];

const ENV_LABELS: Record<string, string> = {
  requiredEnvComplete: "All required environment variables",
  database: "Database URL",
  supabaseAuth: "Supabase auth",
  supabaseServiceRole: "Supabase service role (storage, admin)",
  encryptionKey: "Encryption key (integration secrets)",
  cronSecret: "Cron secret (scheduled jobs)",
  email: "Transactional email (Resend)",
  siteUrl: "Public site URL",
};

const Flag = ({ on }: { on: boolean }) => <Badge tone={on ? "success" : "warning"}>{on ? "Configured" : "Missing"}</Badge>;

export default async function SystemPage() {
  const ctx = await getAccessContext();
  const configure = can(ctx, "system.configure");
  const [settings, env] = configure ? await Promise.all([getOrgSettings(ctx), getEnvironmentStatus(ctx)]) : [null, null];
  const links = LINKS.filter((l) => can(ctx, l.permission));

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Settings", "System"]} title="System configuration" subtitle="Administration hub: users and access, companies, integrations, audit, data and backups." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="rounded-2xl border border-[var(--ic-border)] p-4 hover:bg-[var(--ic-surface-muted)]">
            <p className="font-medium">{l.label}</p>
            <p className="text-xs text-muted">{l.note}</p>
          </Link>
        ))}
      </div>

      {settings && env ? (
        <>
          <Card>
            <CardHeader><CardTitle>Organization settings</CardTitle></CardHeader>
            <CardContent><OrgSettingsForm settings={settings} /></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Environment status</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted">Shows only whether each item is set. Values are never displayed; change them in the hosting provider.</p>
              <ul className="grid gap-2 text-sm sm:grid-cols-2">
                {Object.entries(ENV_LABELS).map(([key, label]) => (
                  <li key={key} className="flex items-center justify-between gap-2"><span>{label}</span><Flag on={Boolean(env[key as keyof typeof env])} /></li>
                ))}
                {Object.entries(env.integrations).map(([provider, connected]) => (
                  <li key={provider} className="flex items-center justify-between gap-2"><span>Integration: {provider}</span><Badge tone={connected ? "success" : "neutral"}>{connected ? "Connected" : "Not connected"}</Badge></li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      ) : (
        <p className="text-sm text-muted">You need the system configure permission to edit organization settings.</p>
      )}
    </div>
  );
}
