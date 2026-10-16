"use client";

import type { ComponentType } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Settings,
  LogOut,
  Plug,
  Shield,
  Building2,
  KanbanSquare,
  CalendarClock,
  GitBranch,
  Radio,
  Package,
  XCircle,
  Heart,
  CheckCircle2,
  BarChart3,
  ListTodo,
  Upload,
  Download,
  Target,
  ShoppingCart,
  Boxes,
  Truck,
  Wallet,
  Contact,
  LifeBuoy,
  Factory,
  MessageSquare,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { logoutAction } from "@/features/auth/actions";

const modules = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, color: "bg-[var(--ic-primary)]" },
  { href: "/analytics", label: "Analytics", icon: BarChart3, color: "bg-fuchsia-500" },
  { href: "/leads", label: "Leads", icon: Target, color: "bg-[var(--ic-module-orange)]" },
  { href: "/crm/customers", label: "CRM", icon: Users, color: "bg-emerald-500", prefix: "/crm" },
  { href: "/sales/quotations", label: "Sales", icon: ShoppingCart, color: "bg-sky-500", prefix: "/sales" },
  { href: "/inventory/products", label: "Inventory", icon: Boxes, color: "bg-amber-500", prefix: "/inventory" },
  { href: "/purchasing/orders", label: "Purchasing", icon: Truck, color: "bg-rose-500", prefix: "/purchasing" },
  { href: "/finance/invoices", label: "Finance", icon: Wallet, color: "bg-violet-500", prefix: "/finance" },
  { href: "/hr/employees", label: "HR", icon: Contact, color: "bg-pink-500", prefix: "/hr" },
  { href: "/projects", label: "Projects", icon: KanbanSquare, color: "bg-lime-600" },
  { href: "/service/tickets", label: "Service", icon: LifeBuoy, color: "bg-cyan-500", prefix: "/service" },
  { href: "/manufacturing/work-orders", label: "Manufacturing", icon: Factory, color: "bg-orange-600", prefix: "/manufacturing" },
  { href: "/communication/messages", label: "Communication", icon: MessageSquare, color: "bg-teal-500", prefix: "/communication" },
  { href: "/automation/approvals", label: "Automation", icon: Workflow, color: "bg-indigo-500", prefix: "/automation" },
  { href: "/settings/organization", label: "Settings", icon: Building2, color: "bg-[var(--ic-module-purple)]", prefix: "/settings" },
] as const;

export function ModuleRail() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-4 flex h-[calc(100vh-2rem)] w-[72px] self-start shrink-0 flex-col items-center gap-3 py-4">
      <Link
        href="/dashboard"
        className="mb-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary text-sm font-bold text-white shadow-card"
        aria-label="IntraCore"
      >
        IC
      </Link>

      <nav className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto overflow-x-visible py-1 [scrollbar-width:none]">
        {modules.map((mod) => {
          const base = "prefix" in mod ? mod.prefix : mod.href;
          const active = pathname === base || pathname.startsWith(`${base}/`);
          const Icon = mod.icon;
          return (
            <Link
              key={mod.href}
              href={mod.href}
              title={mod.label}
              aria-label={mod.label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white transition",
                mod.color,
                active
                  ? "ring-2 ring-offset-2 ring-offset-[var(--ic-canvas)] ring-black/15"
                  : "opacity-85 hover:opacity-100",
              )}
            >
              <Icon className="h-4 w-4" />
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2">
        <form action={logoutAction}>
          <button
            type="submit"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-muted shadow-sm hover:text-danger"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </form>
      </div>
    </aside>
  );
}

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  exact?: boolean;
};

type NavGroup = { title: string; items: NavItem[] };

type LeadNavGroup = {
  title: string;
  category: string;
  items: { href: string; label: string; slug: string }[];
};

const orgNavGroups: NavGroup[] = [
  {
    title: "MY ORGANIZATION",
    items: [
      { href: "/settings/pipelines", label: "Pipelines", icon: GitBranch },
      { href: "/settings/lead-sources", label: "Lead sources", icon: Radio },
      { href: "/settings/lead-products", label: "Products", icon: Package },
      { href: "/settings/custom-fields", label: "Custom fields", icon: Package },
      {
        href: "/settings/organization",
        label: "Organization",
        icon: Building2,
      },
      { href: "/settings/companies", label: "Companies", icon: Building2 },
      { href: "/settings/crm", label: "CRM rules", icon: Users },
      { href: "/settings/catalog", label: "Units & taxes", icon: Package },
      { href: "/settings/users", label: "Users", icon: Users },
      { href: "/settings/roles", label: "Roles", icon: Shield },
      { href: "/settings/notifications", label: "Notifications", icon: Radio },
    ],
  },
  {
    title: "ADMINISTRATOR",
    items: [
      {
        href: "/settings/integrations",
        label: "Integrations",
        icon: Plug,
      },
      { href: "/settings/jobs", label: "Jobs & webhooks", icon: Radio },
      { href: "/settings/system", label: "System configuration", icon: Settings },
      { href: "/settings/portal-users", label: "Portal users", icon: Users },
      { href: "/settings/audit", label: "Audit trail", icon: Shield },
      { href: "/settings/imports", label: "Imports", icon: Upload },
      { href: "/settings/exports", label: "Exports", icon: Download },
      { href: "/settings/retention", label: "Data retention", icon: Settings },
      { href: "/settings/backups", label: "Backups", icon: Shield },
    ],
  },
];

/** Sidebar links for ERP sections, keyed by path prefix. */
const sectionNav: { prefix: string; group: NavGroup }[] = [
  {
    prefix: "/analytics",
    group: {
      title: "ANALYTICS",
      items: [
        { href: "/analytics", label: "Business overview", icon: BarChart3, exact: true },
        { href: "/analytics/mis", label: "Management MIS", icon: BarChart3 },
        { href: "/analytics/reports", label: "Report builder", icon: ListTodo },
      ],
    },
  },
  {
    prefix: "/communication",
    group: {
      title: "COMMUNICATION",
      items: [
        { href: "/communication/messages", label: "Message log", icon: Radio },
        { href: "/communication/templates", label: "Templates", icon: Package },
        { href: "/communication/consent", label: "Consent", icon: Shield },
        { href: "/communication/campaigns", label: "Campaigns", icon: BarChart3 },
        { href: "/communication/segments", label: "Segments", icon: Users },
        { href: "/communication/feedback", label: "Feedback", icon: CheckCircle2 },
        { href: "/communication/loyalty", label: "Loyalty", icon: Package },
      ],
    },
  },
  {
    prefix: "/automation",
    group: {
      title: "AUTOMATION",
      items: [
        { href: "/automation/approvals", label: "Approvals", icon: CheckCircle2 },
        { href: "/automation/workflows", label: "Workflows", icon: GitBranch },
        { href: "/automation/reminders", label: "Reminders", icon: CalendarClock },
        { href: "/automation/notifications", label: "Notification history", icon: Radio },
      ],
    },
  },
  {
    prefix: "/crm",
    group: {
      title: "CRM",
      items: [
        { href: "/crm/customers", label: "Customers", icon: Building2 },
        { href: "/crm/contacts", label: "Contacts", icon: Users },
        { href: "/crm/opportunities", label: "Opportunities", icon: KanbanSquare },
        { href: "/crm/reports", label: "Funnel", icon: BarChart3 },
      ],
    },
  },
  {
    prefix: "/sales",
    group: {
      title: "SALES",
      items: [
        { href: "/sales/quotations", label: "Quotations", icon: ListTodo },
        { href: "/sales/orders", label: "Sales orders", icon: CheckCircle2 },
      ],
    },
  },
  {
    prefix: "/inventory",
    group: {
      title: "INVENTORY",
      items: [
        { href: "/inventory/products", label: "Products", icon: Package },
        { href: "/inventory/stock", label: "Stock levels", icon: BarChart3 },
        { href: "/inventory/entries", label: "Stock entries", icon: ListTodo },
        { href: "/inventory/reorder", label: "Reorder", icon: CalendarClock },
        { href: "/inventory/warehouses", label: "Warehouses", icon: Building2 },
      ],
    },
  },
  {
    prefix: "/purchasing",
    group: {
      title: "PURCHASING",
      items: [
        { href: "/purchasing/vendors", label: "Vendors", icon: Users },
        { href: "/purchasing/orders", label: "Purchase orders", icon: ListTodo },
        { href: "/purchasing/bills", label: "Vendor bills", icon: CheckCircle2 },
      ],
    },
  },
  {
    prefix: "/finance",
    group: {
      title: "FINANCE",
      items: [
        { href: "/finance/invoices", label: "Invoices", icon: ListTodo },
        { href: "/finance/credit-notes", label: "Credit notes", icon: XCircle },
        { href: "/finance/receipts", label: "Receipts", icon: CheckCircle2 },
        { href: "/finance/payments", label: "Vendor payments", icon: Upload },
        { href: "/finance/debit-notes", label: "Debit notes", icon: XCircle },
        { href: "/finance/expenses", label: "Expenses", icon: Package },
        { href: "/finance/bank", label: "Bank & cash", icon: Building2 },
        { href: "/finance/journals", label: "Journals", icon: GitBranch },
        { href: "/finance/reports", label: "Reports & GST", icon: BarChart3 },
        { href: "/finance/setup", label: "Setup", icon: Settings },
      ],
    },
  },
  {
    prefix: "/hr",
    group: {
      title: "HR",
      items: [
        { href: "/hr/employees", label: "Employees", icon: Users },
        { href: "/hr/attendance", label: "Attendance", icon: CalendarClock },
        { href: "/hr/leave", label: "Leave", icon: CalendarClock },
        { href: "/hr/recruitment", label: "Recruitment", icon: Users },
        { href: "/hr/performance", label: "Performance", icon: BarChart3 },
        { href: "/hr/payroll", label: "Payroll", icon: Package },
        { href: "/hr/settings", label: "HR settings", icon: Settings },
      ],
    },
  },
  {
    prefix: "/projects",
    group: { title: "PROJECTS", items: [{ href: "/projects", label: "Projects", icon: KanbanSquare, exact: true }, { href: "/projects/timesheets", label: "My timesheet", icon: CalendarClock }] },
  },
  {
    prefix: "/service",
    group: {
      title: "SERVICE",
      items: [
        { href: "/service/tickets", label: "Tickets", icon: ListTodo },
        { href: "/service/assets", label: "Assets", icon: Package },
        { href: "/service/contracts", label: "AMC contracts", icon: CheckCircle2 },
        { href: "/service/schedule", label: "Field schedule", icon: CalendarClock },
        { href: "/service/installations", label: "Installations", icon: Building2 },
        { href: "/service/dispatch", label: "Dispatch & POD", icon: Upload },
        { href: "/service/reports", label: "Service reports", icon: BarChart3 },
        { href: "/service/settings", label: "SLA & categories", icon: Settings },
      ],
    },
  },
  {
    prefix: "/manufacturing",
    group: {
      title: "MANUFACTURING",
      items: [
        { href: "/manufacturing/work-orders", label: "Work orders", icon: ListTodo },
        { href: "/manufacturing/boms", label: "Bills of materials", icon: Package },
        { href: "/manufacturing/mrp", label: "Material planning", icon: BarChart3 },
        { href: "/manufacturing/quality", label: "Quality", icon: CheckCircle2 },
        { href: "/manufacturing/suppliers", label: "Supplier quality", icon: Users },
      ],
    },
  },
];

function navIconForSlug(slug: string) {
  if (slug.includes("lost")) return XCircle;
  if (slug.includes("re-engaged")) return Heart;
  if (slug.includes("confirmed") || slug.includes("closed")) return CheckCircle2;
  if (slug.includes("report")) return BarChart3;
  if (slug.includes("follow")) return CalendarClock;
  if (slug.includes("call")) return PhoneIcon;
  if (slug.includes("transfer")) return Users;
  return KanbanSquare;
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export function AppSidebar({
  userName,
  roleName,
  organizationName,
  leadNavGroups = [],
}: {
  userName: string;
  roleName: string;
  organizationName: string;
  leadNavGroups?: LeadNavGroup[];
}) {
  const pathname = usePathname();
  const firstName = userName.split(" ")[0] || userName;
  const contextGroups = [
    ...sectionNav.filter((section) => pathname === section.prefix || pathname.startsWith(`${section.prefix}/`)).map((section) => section.group),
    ...(pathname.startsWith("/settings") ? orgNavGroups : []),
  ];
  // Inside an ERP section or settings, show that section's menu; the lead menus belong to Leads.
  const leadMode = contextGroups.length === 0;

  return (
    <aside className="sticky top-4 flex h-[calc(100vh-2rem)] w-full max-w-[240px] self-start shrink-0 flex-col py-5 pr-2 md:w-[240px]">
      <div className="mb-6 flex items-center gap-3 px-2">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
          {firstName.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            Hey, {firstName}
          </p>
          <p className="truncate text-2xs text-muted">{roleName}</p>
          <p className="truncate text-2xs text-subtle">{organizationName}</p>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-1">
        <div>
          <p className="mb-2 px-3 text-2xs font-semibold tracking-wider text-subtle">
            MAIN
          </p>
          <ul className="space-y-1">
            <li>
              <Link
                href="/dashboard"
                className={cn(
                  "flex items-center gap-2.5 rounded-pill px-3 py-2.5 text-sm transition",
                  pathname === "/dashboard"
                    ? "bg-nav-active font-medium text-white shadow-sm"
                    : "text-muted hover:bg-white/70 hover:text-foreground",
                )}
              >
                <LayoutDashboard className="h-4 w-4 shrink-0 opacity-80" />
                Overview
              </Link>
            </li>
            {leadMode ? (
              <>
            <li>
              <Link
                href="/leads/tasks"
                className={cn(
                  "flex items-center gap-2.5 rounded-pill px-3 py-2.5 text-sm transition",
                  pathname.startsWith("/leads/tasks")
                    ? "bg-nav-active font-medium text-white shadow-sm"
                    : "text-muted hover:bg-white/70 hover:text-foreground",
                )}
              >
                <ListTodo className="h-4 w-4 shrink-0 opacity-80" />
                Tasks
              </Link>
            </li>
            <li>
              <Link
                href="/leads/import"
                className={cn(
                  "flex items-center gap-2.5 rounded-pill px-3 py-2.5 text-sm transition",
                  pathname.startsWith("/leads/import")
                    ? "bg-nav-active font-medium text-white shadow-sm"
                    : "text-muted hover:bg-white/70 hover:text-foreground",
                )}
              >
                <Upload className="h-4 w-4 shrink-0 opacity-80" />
                Import
              </Link>
            </li>
              </>
            ) : null}
          </ul>
        </div>

        {(leadMode ? leadNavGroups : []).map((group) => (
          <div key={group.category}>
            <p className="mb-2 px-3 text-2xs font-semibold tracking-wider text-subtle">
              {group.title}
            </p>
            <ul className="space-y-1">
              {group.items.map((item) => {
                const Icon = navIconForSlug(item.slug);
                const active =
                  pathname === item.href ||
                  pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "flex items-center gap-2.5 rounded-pill px-3 py-2.5 text-sm transition",
                        active
                          ? "bg-nav-active font-medium text-white shadow-sm"
                          : "text-muted hover:bg-white/70 hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0 opacity-80" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {contextGroups.length > 0
          ? contextGroups.map((group) => (
              <div key={group.title}>
                <p className="mb-2 px-3 text-2xs font-semibold tracking-wider text-subtle">
                  {group.title}
                </p>
                <ul className="space-y-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const active = item.exact
                      ? pathname === item.href
                      : pathname === item.href ||
                        pathname.startsWith(`${item.href}/`);
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className={cn(
                            "flex items-center gap-2.5 rounded-pill px-3 py-2.5 text-sm transition",
                            active
                              ? "bg-nav-active font-medium text-white shadow-sm"
                              : "text-muted hover:bg-white/70 hover:text-foreground",
                          )}
                        >
                          <Icon className="h-4 w-4 shrink-0 opacity-80" />
                          <span className="truncate">{item.label}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          : null}
      </nav>
    </aside>
  );
}
