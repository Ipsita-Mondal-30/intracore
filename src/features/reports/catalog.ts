import {
  CustomerType,
  EmployeeStatus,
  EmploymentType,
  ExpenseClaimStatus,
  FinanceDocStatus,
  LeadPriority,
  LeadStatus,
  Prisma,
  PurchaseOrderStatus,
  QuotationStatus,
  RecordStatus,
  SalesOrderStatus,
  VendorBillStatus,
} from "@prisma/client";
import { can, type AccessContext } from "@/lib/access";
import { sqlScope } from "@/features/analytics/scope";

/**
 * Report builder allowlist. Every table, join, column expression and scope rule here is a
 * constant written by us; user definitions can only *name* entries of this catalog (see
 * builder.ts), and every value they supply is bound as a query parameter.
 *
 * Scoping (always applied, never optional):
 * - org:            t.organizationId = caller's org
 * - company:        + t.companyId in the caller's companies (tables without a branch)
 * - company_branch: + per company, branch in the caller's branches when branch-limited
 * - plus module visibility where the module has one (leads, tickets, expense claims, projects).
 *
 * Date fields are exposed as calendar dates (timestamps cast to their UTC date).
 */

export type FieldType = "string" | "number" | "money" | "date" | "enum";
export type FieldDef = {
  label: string;
  /** SQL expression over the entity's FROM aliases (hardcoded) */
  sql: string;
  type: FieldType;
  values?: readonly string[];
  /** Default: string/enum/date fields are groupable. Every field is filterable; aggregates follow AGG_TYPES. */
  groupable?: boolean;
};

export type EntityDef = {
  label: string;
  /** Permission needed to read the entity (same as its module's list) */
  permission: string;
  scopeRule: string;
  from: string;
  scope: (ctx: AccessContext, companyIds: string[]) => Prisma.Sql;
  fields: Record<string, FieldDef>;
  defaultColumns: string[];
  /** Deterministic row-mode ordering appended after the user's sort */
  tieBreak: string;
};

export const OPS_BY_TYPE: Record<FieldType, readonly string[]> = {
  string: ["eq", "neq", "in", "contains", "is_null"],
  enum: ["eq", "neq", "in", "is_null"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "is_null"],
  money: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "is_null"],
  date: ["eq", "gt", "gte", "lt", "lte", "between", "is_null"],
};
export const AGGREGATES = ["count", "sum", "avg", "min", "max"] as const;
export type AggregateFn = (typeof AGGREGATES)[number];
export const AGG_TYPES: Record<AggregateFn, readonly FieldType[]> = {
  count: ["string", "number", "money", "date", "enum"],
  sum: ["number", "money"],
  avg: ["number", "money"],
  min: ["number", "money", "date"],
  max: ["number", "money", "date"],
};

const str = (label: string, sql: string): FieldDef => ({ label, sql, type: "string" });
const num = (label: string, sql: string): FieldDef => ({ label, sql, type: "number" });
const amt = (label: string, sql: string): FieldDef => ({ label, sql, type: "money" });
const date = (label: string, sql: string): FieldDef => ({ label, sql: `(${sql})::date`, type: "date" });
const enm = (label: string, sql: string, values: Record<string, string> | readonly string[]): FieldDef => ({
  label,
  sql: `(${sql})::text`,
  type: "enum",
  values: Array.isArray(values) ? values : Object.values(values),
});
const company = str("Company", `co."code"`);

const branchScoped = (ctx: AccessContext, ids: string[]) => sqlScope(ctx, ids, "t", true);
const companyScoped = (ctx: AccessContext, ids: string[]) => sqlScope(ctx, ids, "t", false);

export const REPORT_ENTITIES: Record<string, EntityDef> = {
  customers: {
    label: "Customers",
    permission: "customer.view",
    scopeRule: "organization",
    from: `"customers" t`,
    scope: (ctx) => Prisma.sql`t."organizationId" = ${ctx.organizationId}`,
    fields: {
      code: str("Code", `t."code"`),
      name: str("Name", `t."name"`),
      type: enm("Type", `t."type"`, CustomerType),
      email: str("Email", `t."email"`),
      phone: str("Phone", `t."phone"`),
      gstin: str("GSTIN", `t."gstin"`),
      stateCode: str("State code", `t."stateCode"`),
      status: enm("Status", `t."status"`, RecordStatus),
      paymentTermsDays: num("Payment terms (days)", `t."paymentTermsDays"`),
      creditLimit: amt("Credit limit", `t."creditLimit"`),
      createdAt: date("Created", `t."createdAt"`),
    },
    defaultColumns: ["code", "name", "type", "stateCode", "status"],
    tieBreak: `t."id"`,
  },
  leads: {
    label: "Leads",
    permission: "lead.view",
    scopeRule: "organization; non-archived; all leads with lead.view_all, else only leads assigned to the caller",
    from: `"leads" t LEFT JOIN "lead_stages" st ON st."id" = t."stageId" LEFT JOIN "lead_sources" src ON src."id" = t."sourceId"`,
    scope: (ctx) =>
      Prisma.sql`t."organizationId" = ${ctx.organizationId} AND t."archivedAt" IS NULL AND (${can(ctx, "lead.view_all")}::boolean OR t."assignedUserId" = ${ctx.userId}::uuid)`,
    fields: {
      fullName: str("Name", `t."fullName"`),
      company: str("Company name", `t."company"`),
      email: str("Email", `t."email"`),
      phone: str("Phone", `t."phone"`),
      city: str("City", `t."city"`),
      state: str("State", `t."state"`),
      industry: str("Industry", `t."industry"`),
      status: enm("Status", `t."status"`, LeadStatus),
      priority: enm("Priority", `t."priority"`, LeadPriority),
      stage: str("Stage", `st."name"`),
      source: str("Source", `src."name"`),
      expectedValue: num("Expected value", `t."expectedValue"`),
      leadScore: num("Score", `t."leadScore"`),
      createdAt: date("Created", `t."createdAt"`),
      convertedAt: date("Converted", `t."convertedAt"`),
      nextFollowUpAt: date("Next follow-up", `t."nextFollowUpAt"`),
    },
    defaultColumns: ["fullName", "company", "status", "stage", "createdAt"],
    tieBreak: `t."id"`,
  },
  quotations: {
    label: "Quotations",
    permission: "quotation.view",
    scopeRule: "company and branch",
    from: `"quotations" t JOIN "companies" co ON co."id" = t."companyId" JOIN "customers" c ON c."id" = t."customerId"`,
    scope: branchScoped,
    fields: {
      number: str("Number", `t."number"`),
      revision: num("Revision", `t."revision"`),
      company,
      customer: str("Customer", `c."name"`),
      status: enm("Status", `t."status"`, QuotationStatus),
      issueDate: date("Issue date", `t."issueDate"`),
      validUntil: date("Valid until", `t."validUntil"`),
      taxableTotal: amt("Taxable value", `t."taxableTotal"`),
      taxTotal: amt("Tax", `t."taxTotal"`),
      grandTotal: amt("Grand total", `t."grandTotal"`),
      sentAt: date("Sent", `t."sentAt"`),
      decidedAt: date("Decided", `t."decidedAt"`),
      createdAt: date("Created", `t."createdAt"`),
    },
    defaultColumns: ["number", "revision", "customer", "status", "issueDate", "grandTotal"],
    tieBreak: `t."id"`,
  },
  sales_orders: {
    label: "Sales orders",
    permission: "sales_order.view",
    scopeRule: "company and branch",
    from: `"sales_orders" t JOIN "companies" co ON co."id" = t."companyId" JOIN "customers" c ON c."id" = t."customerId"`,
    scope: branchScoped,
    fields: {
      number: str("Number", `t."number"`),
      company,
      customer: str("Customer", `c."name"`),
      status: enm("Status", `t."status"`, SalesOrderStatus),
      orderDate: date("Order date", `t."orderDate"`),
      expectedDeliveryDate: date("Expected delivery", `t."expectedDeliveryDate"`),
      taxableTotal: amt("Taxable value", `t."taxableTotal"`),
      grandTotal: amt("Grand total", `t."grandTotal"`),
      confirmedAt: date("Confirmed", `t."confirmedAt"`),
    },
    defaultColumns: ["number", "customer", "status", "orderDate", "grandTotal"],
    tieBreak: `t."id"`,
  },
  sales_invoices: {
    label: "Sales invoices",
    permission: "invoice.view",
    scopeRule: "company and branch",
    from: `"sales_invoices" t JOIN "companies" co ON co."id" = t."companyId" JOIN "customers" c ON c."id" = t."customerId"`,
    scope: branchScoped,
    fields: {
      number: str("Number", `t."number"`),
      company,
      customer: str("Customer", `c."name"`),
      status: enm("Status", `t."status"`, FinanceDocStatus),
      invoiceDate: date("Invoice date", `t."invoiceDate"`),
      dueDate: date("Due date", `t."dueDate"`),
      placeOfSupplyState: str("Place of supply", `t."placeOfSupplyState"`),
      taxableTotal: amt("Taxable value", `t."taxableTotal"`),
      taxTotal: amt("Tax", `t."taxTotal"`),
      grandTotal: amt("Grand total", `t."grandTotal"`),
      paidAmount: amt("Paid", `t."paidAmount"`),
      creditedAmount: amt("Credited", `t."creditedAmount"`),
      outstanding: amt("Outstanding", `(t."grandTotal" - t."paidAmount" - t."creditedAmount")`),
    },
    defaultColumns: ["number", "customer", "status", "invoiceDate", "grandTotal", "outstanding"],
    tieBreak: `t."id"`,
  },
  purchase_orders: {
    label: "Purchase orders",
    permission: "purchase_order.view",
    scopeRule: "company and branch",
    from: `"purchase_orders" t JOIN "companies" co ON co."id" = t."companyId" JOIN "vendors" v ON v."id" = t."vendorId"`,
    scope: branchScoped,
    fields: {
      number: str("Number", `t."number"`),
      company,
      vendor: str("Vendor", `v."name"`),
      status: enm("Status", `t."status"`, PurchaseOrderStatus),
      orderDate: date("Order date", `t."orderDate"`),
      expectedDate: date("Expected", `t."expectedDate"`),
      taxableTotal: amt("Taxable value", `t."taxableTotal"`),
      grandTotal: amt("Grand total", `t."grandTotal"`),
    },
    defaultColumns: ["number", "vendor", "status", "orderDate", "grandTotal"],
    tieBreak: `t."id"`,
  },
  vendor_bills: {
    label: "Vendor bills",
    permission: "vendor_bill.view",
    scopeRule: "company and branch",
    from: `"vendor_bills" t JOIN "companies" co ON co."id" = t."companyId" JOIN "vendors" v ON v."id" = t."vendorId"`,
    scope: branchScoped,
    fields: {
      number: str("Number", `t."number"`),
      vendorInvoiceNumber: str("Vendor invoice no.", `t."vendorInvoiceNumber"`),
      company,
      vendor: str("Vendor", `v."name"`),
      status: enm("Status", `t."status"`, VendorBillStatus),
      billDate: date("Bill date", `t."billDate"`),
      dueDate: date("Due date", `t."dueDate"`),
      taxableTotal: amt("Taxable value", `t."taxableTotal"`),
      taxTotal: amt("Tax", `t."taxTotal"`),
      grandTotal: amt("Grand total", `t."grandTotal"`),
      paidAmount: amt("Paid", `t."paidAmount"`),
      outstanding: amt("Outstanding", `(t."grandTotal" - t."paidAmount" - t."debitedAmount")`),
    },
    defaultColumns: ["number", "vendor", "status", "billDate", "grandTotal", "outstanding"],
    tieBreak: `t."id"`,
  },
  stock_balances: {
    label: "Stock balances",
    permission: "inventory.view",
    scopeRule: "company (stock tables carry no branch; same as stock levels)",
    from: `"stock_balances" t JOIN "companies" co ON co."id" = t."companyId" JOIN "products" p ON p."id" = t."productId" JOIN "warehouses" w ON w."id" = t."warehouseId"`,
    scope: companyScoped,
    fields: {
      company,
      warehouse: str("Warehouse", `w."code"`),
      sku: str("SKU", `p."sku"`),
      product: str("Product", `p."name"`),
      quantity: num("On hand (base unit)", `t."quantity"`),
      updatedAt: date("Last movement", `t."updatedAt"`),
    },
    defaultColumns: ["warehouse", "sku", "product", "quantity"],
    tieBreak: `t."id"`,
  },
  expense_claims: {
    label: "Expense claims",
    permission: "expense.view",
    scopeRule: "company; all claims with expense.approve or expense.pay, else only the caller's own",
    from: `"expense_claims" t JOIN "companies" co ON co."id" = t."companyId" JOIN "users" u ON u."id" = t."claimantId"`,
    scope: (ctx, ids) =>
      Prisma.sql`${companyScoped(ctx, ids)} AND (${can(ctx, "expense.approve") || can(ctx, "expense.pay")}::boolean OR t."claimantId" = ${ctx.userId}::uuid)`,
    fields: {
      number: str("Number", `t."number"`),
      company,
      title: str("Title", `t."title"`),
      claimant: str("Claimant", `COALESCE(u."name", u."email")`),
      status: enm("Status", `t."status"`, ExpenseClaimStatus),
      totalAmount: amt("Amount", `t."totalAmount"`),
      submittedAt: date("Submitted", `t."submittedAt"`),
      approvedAt: date("Approved", `t."approvedAt"`),
      paidAt: date("Paid", `t."paidAt"`),
      createdAt: date("Created", `t."createdAt"`),
    },
    defaultColumns: ["number", "claimant", "title", "status", "totalAmount"],
    tieBreak: `t."id"`,
  },
  tickets: {
    label: "Service tickets",
    permission: "ticket.view",
    scopeRule: "company; all tickets with ticket.assign, else tickets assigned to or created by the caller",
    from: `"tickets" t JOIN "companies" co ON co."id" = t."companyId" LEFT JOIN "customers" c ON c."id" = t."customerId" LEFT JOIN "ticket_categories" tc ON tc."id" = t."categoryId" LEFT JOIN "users" u ON u."id" = t."assigneeId"`,
    scope: (ctx, ids) =>
      Prisma.sql`${companyScoped(ctx, ids)} AND (${can(ctx, "ticket.assign")}::boolean OR t."assigneeId" = ${ctx.userId}::uuid OR t."createdById" = ${ctx.userId}::uuid)`,
    fields: {
      number: str("Number", `t."number"`),
      company,
      subject: str("Subject", `t."subject"`),
      customer: str("Customer", `c."name"`),
      category: str("Category", `tc."name"`),
      priority: enm("Priority", `t."priority"`, LeadPriority),
      status: enm("Status", `t."status"`, ["NEW", "OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED", "CANCELLED"]),
      source: enm("Source", `t."source"`, ["EMAIL", "PHONE", "PORTAL", "WALK_IN", "OTHER"]),
      assignee: str("Assignee", `COALESCE(u."name", u."email")`),
      createdAt: date("Created", `t."createdAt"`),
      resolutionDueAt: date("Resolution due", `t."resolutionDueAt"`),
      resolvedAt: date("Resolved", `t."resolvedAt"`),
      resolutionHours: num("Resolution hours", `ROUND((EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")) / 3600)::numeric, 1)`),
      feedbackRating: num("Rating", `t."feedbackRating"`),
    },
    defaultColumns: ["number", "subject", "priority", "status", "createdAt"],
    tieBreak: `t."id"`,
  },
  employees: {
    label: "Employees",
    permission: "employee.view",
    scopeRule: "company and branch; non-sensitive fields only (no contact details, date of birth, exit reasons or pay)",
    from: `"employees" t JOIN "companies" co ON co."id" = t."companyId" LEFT JOIN "branches" b ON b."id" = t."branchId" LEFT JOIN "departments" d ON d."id" = t."departmentId" LEFT JOIN "designations" dg ON dg."id" = t."designationId"`,
    scope: branchScoped,
    fields: {
      employeeNumber: str("Employee no.", `t."employeeNumber"`),
      fullName: str("Name", `t."fullName"`),
      company,
      branch: str("Branch", `b."name"`),
      department: str("Department", `d."name"`),
      designation: str("Designation", `dg."name"`),
      employmentType: enm("Employment type", `t."employmentType"`, EmploymentType),
      status: enm("Status", `t."status"`, EmployeeStatus),
      joiningDate: date("Joined", `t."joiningDate"`),
      exitDate: date("Exited", `t."exitDate"`),
    },
    defaultColumns: ["employeeNumber", "fullName", "department", "designation", "status"],
    tieBreak: `t."id"`,
  },
  time_entries: {
    label: "Time entries",
    permission: "project.view",
    scopeRule: "projects in the caller's companies; all with project.update, else projects the caller is a member of",
    from: `"time_entries" t JOIN "projects" p ON p."id" = t."projectId" JOIN "companies" co ON co."id" = p."companyId" LEFT JOIN "project_tasks" pt ON pt."id" = t."taskId" JOIN "users" u ON u."id" = t."userId"`,
    scope: (ctx, ids) =>
      Prisma.sql`t."organizationId" = ${ctx.organizationId} AND ${sqlScope(ctx, ids, "p", false)}
        AND (${can(ctx, "project.update")}::boolean OR EXISTS (SELECT 1 FROM "project_members" pm WHERE pm."projectId" = p."id" AND pm."userId" = ${ctx.userId}::uuid))`,
    fields: {
      date: date("Date", `t."date"`),
      project: str("Project", `p."code"`),
      projectName: str("Project name", `p."name"`),
      company,
      task: str("Task", `pt."title"`),
      user: str("User", `COALESCE(u."name", u."email")`),
      hours: num("Hours", `t."hours"`),
      billable: enm("Billable", `CASE WHEN t."billable" THEN 'true' ELSE 'false' END`, ["true", "false"]),
      description: str("Description", `t."description"`),
    },
    defaultColumns: ["date", "project", "user", "hours", "billable"],
    tieBreak: `t."id"`,
  },
};

export const isGroupable = (f: FieldDef) => f.groupable ?? (f.type !== "number" && f.type !== "money");

/** The catalog as plain data for the builder UI, limited to entities the caller may read. */
export function reportCatalog(ctx: AccessContext) {
  return Object.entries(REPORT_ENTITIES)
    .filter(([, e]) => can(ctx, e.permission))
    .map(([key, e]) => ({
      key,
      label: e.label,
      permission: e.permission,
      scopeRule: e.scopeRule,
      defaultColumns: e.defaultColumns,
      fields: Object.entries(e.fields).map(([fieldKey, f]) => ({
        key: fieldKey,
        label: f.label,
        type: f.type,
        values: f.values ? [...f.values] : undefined,
        ops: [...OPS_BY_TYPE[f.type]],
        groupable: isGroupable(f),
        aggregates: AGGREGATES.filter((fn) => AGG_TYPES[fn].includes(f.type)),
      })),
    }));
}
