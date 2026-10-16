"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
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

type RailModule = {
  href: string;
  /** Short name shown under the icon */
  label: string;
  /** Full name and contents, shown in the tooltip */
  title: string;
  hint: string;
  icon: ComponentType<{ className?: string }>;
  /** Path prefix that marks the module active (defaults to href) */
  prefix?: string;
};

/** Grouped so related modules sit together; groups are separated by a divider. */
const moduleGroups: RailModule[][] = [
  [
    { href: "/dashboard", label: "Home", title: "Overview", hint: "Your dashboard", icon: LayoutDashboard },
    { href: "/analytics", label: "Analytics", title: "Analytics", hint: "Business overview, MIS, report builder", icon: BarChart3 },
  ],
  [
    { href: "/leads", label: "Leads", title: "Leads", hint: "Lead pipeline, follow-ups, calls", icon: Target },
    { href: "/crm/customers", label: "CRM", title: "CRM", hint: "Customers, contacts, opportunities", icon: Users, prefix: "/crm" },
    { href: "/sales/quotations", label: "Sales", title: "Sales", hint: "Quotations and sales orders", icon: ShoppingCart, prefix: "/sales" },
  ],
  [
    { href: "/inventory/products", label: "Stock", title: "Inventory", hint: "Products, warehouses, stock entries", icon: Boxes, prefix: "/inventory" },
    { href: "/purchasing/orders", label: "Purchase", title: "Purchasing", hint: "Vendors, purchase orders, bills", icon: Truck, prefix: "/purchasing" },
    { href: "/manufacturing/work-orders", label: "Factory", title: "Manufacturing", hint: "BOMs, work orders, quality", icon: Factory, prefix: "/manufacturing" },
    { href: "/finance/invoices", label: "Finance", title: "Finance", hint: "Invoices, payments, expenses, GST", icon: Wallet, prefix: "/finance" },
  ],
  [
    { href: "/hr/employees", label: "HR", title: "HR", hint: "Employees, attendance, leave, payroll", icon: Contact, prefix: "/hr" },
    { href: "/projects", label: "Projects", title: "Projects", hint: "Projects, tasks, timesheets", icon: KanbanSquare },
    { href: "/service/tickets", label: "Service", title: "Service", hint: "Tickets, AMC, assets, field work", icon: LifeBuoy, prefix: "/service" },
  ],
  [
    { href: "/communication/messages", label: "Outreach", title: "Communication", hint: "Messages, templates, campaigns, loyalty", icon: MessageSquare, prefix: "/communication" },
    { href: "/automation/approvals", label: "Automate", title: "Automation", hint: "Approvals, workflows, reminders", icon: Workflow, prefix: "/automation" },
  ],
];

const settingsModule: RailModule = {
  href: "/settings/organization",
  label: "Settings",
  title: "Settings",
  hint: "Organization, users, roles, integrations",
  icon: Settings,
  prefix: "/settings",
};

type Tip = { title: string; hint: string; top: number; left: number };

function RailLink({ mod, active, onTip }: { mod: RailModule; active: boolean; onTip: (tip: Tip | null) => void }) {
  const Icon = mod.icon;
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    onTip({ title: mod.title, hint: mod.hint, top: r.top + r.height / 2, left: r.right + 10 });
  };
  return (
    <Link
      href={mod.href}
      aria-label={`${mod.title}: ${mod.hint}`}
      aria-current={active ? "page" : undefined}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => onTip(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => onTip(null)}
      className={cn(
        "flex w-[60px] shrink-0 flex-col items-center gap-1 rounded-xl px-1 py-[5px] outline-none transition",
        "focus-visible:ring-2 focus-visible:ring-primary/60",
        active ? "bg-primary-soft text-primary ring-1 ring-inset ring-[var(--ic-primary-outline)]" : "text-[var(--ic-foreground)]/70 hover:bg-[var(--ic-surface-muted)] hover:text-foreground",
      )}
    >
      <Icon className="h-[19px] w-[19px]" />
      <span className={cn("w-full truncate text-center text-[10.5px] leading-none", active ? "font-semibold" : "font-medium")}>{mod.label}</span>
    </Link>
  );
}

export function ModuleRail() {
  const pathname = usePathname();
  const [tip, setTip] = useState<Tip | null>(null);
  const navRef = useRef<HTMLElement>(null);
  // On short screens the list scrolls: keep the current module in view.
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [pathname]);
  const isActive = (m: RailModule) => {
    const base = m.prefix ?? m.href;
    return pathname === base || pathname.startsWith(`${base}/`);
  };

  return (
    <aside
      className="sticky top-4 mr-2 flex h-[calc(100vh-2rem)] w-[76px] shrink-0 flex-col items-center self-start rounded-2xl border border-[var(--ic-border)] bg-white py-3 shadow-card"
      aria-label="Modules"
    >
      <Link
        href="/dashboard"
        className="mb-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-xs font-bold text-white"
        aria-label="IntraCore home"
      >
        IC
      </Link>

      <nav
        ref={navRef}
        className="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto px-2 py-1 [scrollbar-width:none] [mask-image:linear-gradient(to_bottom,transparent,black_10px,black_calc(100%-18px),transparent)]"
        onScroll={() => setTip(null)}
      >
        {moduleGroups.map((group, i) => (
          <div key={i} className="flex w-full flex-col items-center gap-0.5">
            {i > 0 ? <div className="my-1 h-px w-8 bg-[var(--ic-border)]" aria-hidden /> : null}
            {group.map((mod) => (
              <RailLink key={mod.href} mod={mod} active={isActive(mod)} onTip={setTip} />
            ))}
          </div>
        ))}
      </nav>

      <div className="mt-2 flex w-full flex-col items-center gap-0.5 border-t border-[var(--ic-border)] px-2 pt-2">
        <RailLink mod={settingsModule} active={isActive(settingsModule)} onTip={setTip} />
        <form action={logoutAction} className="w-full">
          <button
            type="submit"
            aria-label="Sign out"
            onMouseEnter={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setTip({ title: "Sign out", hint: "End your session on this device", top: r.top + r.height / 2, left: r.right + 10 });
            }}
            onMouseLeave={() => setTip(null)}
            className="mx-auto flex w-[60px] flex-col items-center gap-1 rounded-xl px-1 py-[5px] text-[var(--ic-foreground)]/70 transition hover:bg-red-50 hover:text-danger focus-visible:ring-2 focus-visible:ring-danger/50 outline-none"
          >
            <LogOut className="h-[19px] w-[19px]" />
            <span className="text-[10.5px] font-medium leading-none">Sign out</span>
          </button>
        </form>
      </div>

      {tip ? (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[60] max-w-[240px] -translate-y-1/2 rounded-lg bg-[var(--ic-nav-active)] px-3 py-2 text-white shadow-lg"
          style={{ top: tip.top, left: tip.left }}
        >
          <span className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 bg-[var(--ic-nav-active)]" aria-hidden />
          <p className="text-xs font-semibold">{tip.title}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-white/75">{tip.hint}</p>
        </div>
      ) : null}
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
