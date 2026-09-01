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
];

export type SystemRoleTemplate = {
  code: string;
  name: string;
  description: string;
  /** Permission codes; use "*" for all */
  permissions: string[] | "*";
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
    permissions: [
      "org.view",
      "org.update",
      "org.manage",
      "member.view",
      "member.invite",
      "member.remove",
      "member.change_role",
      "role.view",
      "role.manage",
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
      "lead.manage_views",
      "lead.transfer",
      "lead.reengage",
      "lead.manage_flags",
      "lead.log_calls",
      "chat.view",
      "chat.send",
      "chat.manage",
      "integration.view",
      "integration.connect",
      "integration.disconnect",
      "integration.manage",
    ],
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
    ],
  },
  {
    code: "support_executive",
    name: "Support Executive",
    description: "Support access to lead information",
    permissions: ["org.view", "dashboard.view", "lead.view", "chat.view"],
  },
  {
    code: "viewer",
    name: "Viewer",
    description: "Read-only access",
    permissions: [
      "org.view",
      "member.view",
      "role.view",
      "dashboard.view",
      "lead.view",
      "chat.view",
      "integration.view",
    ],
  },
];
