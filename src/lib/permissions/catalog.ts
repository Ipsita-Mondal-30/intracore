/**
 * Global permission catalog and per-organization system role templates.
 * Permissions are seeded once; roles are cloned when an organization is created.
 */

export type PermissionSeed = {
  code: string;
  name: string;
  module: string;
  description?: string;
};

/** `module.action` permission rows for a module, e.g. perms("customer", "view", "create"). */
function perms(module: string, ...actions: string[]): PermissionSeed[] {
  return actions.map((action) => ({
    code: `${module}.${action}`,
    name: `${action.replace(/_/g, " ")} ${module.replace(/_/g, " ")}`,
    module,
  }));
}

export const PERMISSIONS: PermissionSeed[] = [
  // Organization
  { code: "org.view", name: "View organization", module: "org" },
  { code: "org.update", name: "Update organization", module: "org" },
  { code: "org.manage", name: "Manage organization", module: "org" },

  // Members
  { code: "member.view", name: "View members", module: "member" },
  { code: "member.invite", name: "Invite members", module: "member" },
  { code: "member.remove", name: "Remove members", module: "member" },
  { code: "member.change_role", name: "Change member roles", module: "member" },

  // Roles
  { code: "role.view", name: "View roles", module: "role" },
  { code: "role.manage", name: "Manage roles", module: "role" },

  // Dashboard
  { code: "dashboard.view", name: "View dashboard", module: "dashboard" },

  // Leads (seeded for later phases)
  { code: "lead.create", name: "Create leads", module: "lead" },
  { code: "lead.view", name: "View leads", module: "lead" },
  { code: "lead.view_all", name: "View all leads", module: "lead" },
  { code: "lead.edit", name: "Edit leads", module: "lead" },
  { code: "lead.delete", name: "Delete leads", module: "lead" },
  { code: "lead.assign", name: "Assign leads", module: "lead" },
  { code: "lead.import", name: "Import leads", module: "lead" },
  { code: "lead.export", name: "Export leads", module: "lead" },
  { code: "lead.convert", name: "Convert leads", module: "lead" },
  { code: "lead.change_stage", name: "Change lead stage", module: "lead" },
  { code: "lead.manage_pipeline", name: "Manage pipelines", module: "lead" },
  { code: "lead.manage_sources", name: "Manage lead sources", module: "lead" },
  { code: "lead.manage_products", name: "Manage lead products", module: "lead" },
  {
    code: "lead.manage_custom_fields",
    name: "Manage custom fields",
    module: "lead",
  },
  { code: "lead.manage_views", name: "Manage lead views", module: "lead" },
  { code: "lead.transfer", name: "Transfer leads", module: "lead" },
  { code: "lead.reengage", name: "Re-engage leads", module: "lead" },
  { code: "lead.manage_flags", name: "Manage lead flags", module: "lead" },
  { code: "lead.log_calls", name: "Log calls", module: "lead" },

  // Chat
  { code: "chat.view", name: "View chat", module: "chat" },
  { code: "chat.send", name: "Send chat messages", module: "chat" },
  { code: "chat.manage", name: "Manage chat settings", module: "chat" },

  // Integrations (seeded for later phases)
  { code: "integration.view", name: "View integrations", module: "integration" },
  {
    code: "integration.connect",
    name: "Connect integrations",
    module: "integration",
  },
  {
    code: "integration.disconnect",
    name: "Disconnect integrations",
    module: "integration",
  },
  {
    code: "integration.manage",
    name: "Manage integrations",
    module: "integration",
  },

  // ERP foundation
  ...perms("company", "view", "create", "update", "administer"),
  ...perms("audit", "view"),
  ...perms("task", "create", "view_all"),
  ...perms("document", "view", "create", "delete"),

  // CRM
  ...perms("customer", "view", "create", "update", "delete", "export"),
  ...perms("contact", "view", "create", "update", "delete"),
  ...perms("opportunity", "view", "create", "update", "delete"),
  ...perms("activity", "create"),
  ...perms("crm", "report", "administer"),

  // Catalog
  ...perms("product", "view", "create", "update", "delete"),
  ...perms("catalog", "administer"),

  // Sales
  ...perms("quotation", "view", "create", "update", "approve", "delete", "export"),
  ...perms("sales_order", "view", "create", "update", "cancel", "export"),

  // Inventory & purchasing
  ...perms("inventory", "view", "create", "post", "administer"),
  ...perms("vendor", "view", "create", "update", "delete"),
  ...perms("purchase_order", "view", "create", "update", "approve", "cancel"),
  ...perms("vendor_bill", "view", "create", "approve", "post", "cancel"),

  // Finance
  ...perms("finance", "view", "post", "report", "administer"),
  ...perms("invoice", "view", "create", "post", "cancel"),
  ...perms("receipt", "view", "create", "cancel"),
  ...perms("payment", "view", "create", "cancel"),
  ...perms("expense", "view", "create", "approve", "pay"),

  // HR and workforce
  ...perms("hr", "view", "administer"),
  ...perms("employee", "view", "create", "update"),
  ...perms("attendance", "view", "self", "record", "approve"),
  ...perms("leave", "view", "apply", "approve"),
  ...perms("recruitment", "view", "manage"),
  ...perms("performance", "view", "manage"),
  ...perms("payroll", "view", "run", "approve"),

  // Projects
  ...perms("project", "view", "create", "update", "delete"),

  // Service, assets and field work
  ...perms("ticket", "view", "create", "update", "assign"),
  ...perms("service", "administer"),
  ...perms("asset", "view", "create", "update"),
  ...perms("contract", "view", "create", "update"),
  ...perms("field", "view", "schedule", "update"),

  // Manufacturing and quality
  ...perms("manufacturing", "view", "create", "release", "produce"),
  ...perms("quality", "view", "inspect", "manage"),
  ...perms("supplier", "evaluate"),

  // Automation, communication, marketing, integrations
  ...perms("workflow", "view", "manage"),
  ...perms("approval", "view_all"),
  ...perms("communication", "view", "send", "administer"),
  ...perms("consent", "view", "manage"),
  ...perms("campaign", "view", "manage", "approve"),
  ...perms("feedback", "view", "create"),
  ...perms("loyalty", "view", "manage"),
  ...perms("signature", "view", "request"),
  ...perms("job", "view", "replay"),

  // Portals, analytics and administration
  ...perms("portal", "manage"),
  ...perms("report", "build"),
  ...perms("data", "import", "export"),
  ...perms("system", "configure"),
  ...perms("retention", "manage"),
  ...perms("backup", "view"),
];

/** Every staff role (not Viewer) can apply for leave, mark own attendance and claim expenses. */
const SELF_SERVICE = ["leave.apply", "attendance.self", "expense.view", "expense.create"];

/** Every `module.action` code of the given modules (optionally only some actions). */
function codes(modules: string[], actions?: string[]) {
  return PERMISSIONS.filter(
    (p) => modules.includes(p.module) && (!actions || actions.includes(p.code.split(".")[1])),
  ).map((p) => p.code);
}

export type SystemRoleTemplate = {
  code: string;
  name: string;
  description: string;
  /** Permission codes, "*" for all, or a filter over the whole catalog */
  permissions: string[] | "*" | ((all: string[]) => string[]);
};

export const SYSTEM_ROLE_TEMPLATES: SystemRoleTemplate[] = [
  {
    code: "owner",
    name: "Owner",
    description: "Full access to the organization",
    permissions: "*",
  },
  {
    code: "super_admin",
    name: "Super Admin",
    description: "Near-full administrative access",
    permissions: "*",
  },
  {
    code: "admin",
    name: "Admin",
    description: "Organization and CRM administration",
    permissions: "*",
  },
  {
    code: "sales_manager",
    name: "Sales Manager",
    description: "Manage sales team leads and assignments",
    permissions: [
      "org.view",
      "member.view",
      "dashboard.view",
      "lead.create",
      "lead.view",
      "lead.view_all",
      "lead.edit",
      "lead.assign",
      "lead.export",
      "lead.convert",
      "lead.change_stage",
      "lead.transfer",
      "lead.reengage",
      "lead.log_calls",
      "chat.view",
      "chat.send",
      "role.view",
      "company.view",
      "task.create",
      "task.view_all",
      "document.view",
      "document.create",
      "product.view",
      "crm.report",
      ...codes(["customer", "contact", "opportunity", "activity", "quotation", "sales_order"]),
      "inventory.view",
      "invoice.view",
      "receipt.view",
      "expense.view",
      "expense.create",
    ],
  },
  {
    code: "sales_executive",
    name: "Sales Executive",
    description: "Work assigned leads",
    permissions: [
      "org.view",
      "dashboard.view",
      "lead.create",
      "lead.view",
      "lead.edit",
      "lead.change_stage",
      "lead.convert",
      "lead.log_calls",
      "chat.view",
      "chat.send",
      "company.view",
      "task.create",
      "document.view",
      "document.create",
      "product.view",
      "activity.create",
      ...codes(["customer", "contact", "opportunity", "quotation"], ["view", "create", "update"]),
      ...codes(["sales_order"], ["view", "create"]),
      "inventory.view",
      "invoice.view",
      "expense.view",
      "expense.create",
    ],
  },
  {
    code: "marketing_manager",
    name: "Marketing Manager",
    description: "Marketing and lead acquisition",
    permissions: [
      "org.view",
      "dashboard.view",
      "lead.view",
      "lead.view_all",
      "lead.import",
      "lead.export",
      "lead.manage_sources",
      "integration.view",
      "integration.connect",
      "customer.view",
      "contact.view",
      "crm.report",
      "campaign.view",
      "campaign.manage",
      "communication.view",
      "communication.send",
      ...codes(["consent", "feedback", "loyalty"]),
    ],
  },
  {
    code: "marketing_executive",
    name: "Marketing Executive",
    description: "Marketing execution",
    permissions: [
      "org.view",
      "dashboard.view",
      "lead.view",
      "lead.import",
      "integration.view",
    ],
  },
  {
    code: "crm_manager",
    name: "CRM Manager",
    description: "CRM configuration and lead lifecycle",
    permissions: [
      "org.view",
      "member.view",
      "role.view",
      "dashboard.view",
      "lead.create",
      "lead.view",
      "lead.view_all",
      "lead.edit",
      "lead.delete",
      "lead.assign",
      "lead.import",
      "lead.export",
      "lead.convert",
      "lead.change_stage",
      "lead.manage_pipeline",
      "lead.manage_sources",
      "lead.manage_products",
      "lead.manage_custom_fields",
      "company.view",
      "task.create",
      "task.view_all",
      "document.view",
      "document.create",
      "product.view",
      ...codes(["customer", "contact", "opportunity", "activity", "crm"]),
    ],
  },
  {
    code: "support_executive",
    name: "Support Executive",
    description: "Support access to lead information",
    permissions: [
      "org.view",
      "dashboard.view",
      "lead.view",
      "chat.view",
      "customer.view",
      "contact.view",
      "activity.create",
      "task.create",
    ],
  },
  {
    code: "inventory_manager",
    name: "Inventory Manager",
    description: "Products, warehouses, stock entries and deliveries",
    permissions: [
      "org.view",
      "dashboard.view",
      "company.view",
      "task.create",
      "document.view",
      "document.create",
      ...codes(["product", "inventory"]),
      "catalog.administer",
      "sales_order.view",
      "purchase_order.view",
      "vendor.view",
      "expense.view",
      "expense.create",
    ],
  },
  {
    code: "purchase_manager",
    name: "Purchase Manager",
    description: "Vendors, purchase orders, receipts and vendor bills",
    permissions: [
      "org.view",
      "dashboard.view",
      "company.view",
      "task.create",
      "task.view_all",
      "document.view",
      "document.create",
      "product.view",
      "product.create",
      "product.update",
      ...codes(["vendor", "purchase_order", "vendor_bill"]),
      ...codes(["inventory"], ["view", "create", "post"]),
      "payment.view",
      "expense.view",
      "expense.create",
    ],
  },
  {
    code: "accountant",
    name: "Accountant",
    description: "Invoices, receipts, bills, payments, expenses, ledger and GST reports",
    permissions: [
      "org.view",
      "dashboard.view",
      "company.view",
      "task.create",
      "audit.view",
      "document.view",
      "document.create",
      ...codes(["finance", "invoice", "receipt", "payment", "expense"]),
      ...codes(["vendor_bill"]),
      "customer.view",
      "vendor.view",
      "product.view",
      "sales_order.view",
      "purchase_order.view",
      "inventory.view",
    ],
  },
  {
    code: "hr_manager",
    name: "HR Manager",
    description: "Employees, attendance, leave, recruitment, performance and payroll",
    permissions: ["org.view", "dashboard.view", "company.view", "task.create", "task.view_all", "document.view", "document.create",
      ...codes(["hr", "employee", "attendance", "leave", "recruitment", "performance", "payroll"])],
  },
  {
    code: "project_manager",
    name: "Project Manager",
    description: "Projects, milestones, tasks and timesheets",
    permissions: ["org.view", "dashboard.view", "company.view", "task.create", "document.view", "document.create", "customer.view", ...codes(["project"])],
  },
  {
    code: "service_manager",
    name: "Service Manager",
    description: "Tickets, SLAs, assets, warranties, AMCs and field work",
    permissions: ["org.view", "dashboard.view", "company.view", "task.create", "task.view_all", "document.view", "document.create",
      "customer.view", "contact.view", "product.view", "quotation.create", "quotation.view",
      ...codes(["ticket", "service", "asset", "contract", "field"])],
  },
  {
    code: "technician",
    name: "Service Technician",
    description: "Assigned tickets, visits and installation jobs",
    permissions: ["org.view", "company.view", "document.view", "document.create", "customer.view", "asset.view",
      "ticket.view", "ticket.update", "field.view", "field.update"],
  },
  {
    code: "production_manager",
    name: "Production Manager",
    description: "Bills of materials, work orders and production",
    permissions: ["org.view", "dashboard.view", "company.view", "task.create", "document.view", "document.create",
      "product.view", ...codes(["manufacturing"]), ...codes(["inventory"], ["view", "create", "post"]), "quality.view", "quality.inspect"],
  },
  {
    code: "quality_manager",
    name: "Quality Manager",
    description: "Inspections, non-conformances and supplier qualification",
    permissions: ["org.view", "dashboard.view", "company.view", "task.create", "task.view_all", "document.view", "document.create",
      "product.view", "vendor.view", "purchase_order.view", "inventory.view", "manufacturing.view", ...codes(["quality", "supplier"])],
  },
  {
    code: "viewer",
    name: "Viewer",
    description: "Read-only access",
    permissions: (all) => all.filter((code) => code.endsWith(".view")),
  },
];

const ALL_CODES = PERMISSIONS.map((p) => p.code);

/** Resolved permission codes for a system role template (empty for unknown codes). */
export function systemRolePermissions(roleCode: string): string[] {
  const template = SYSTEM_ROLE_TEMPLATES.find((t) => t.code === roleCode);
  if (!template) return [];
  if (template.permissions === "*") return ALL_CODES;
  if (typeof template.permissions === "function") return template.permissions(ALL_CODES);
  return [...new Set([...template.permissions, ...(roleCode === "viewer" ? [] : SELF_SERVICE)])];
}
