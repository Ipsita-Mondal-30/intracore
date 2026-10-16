import {
  ApprovalStatus,
  CustomerType,
  ExpenseClaimStatus,
  FinanceDocStatus,
  LeadPriority,
  LeadStatus,
  OpportunityStage,
  PurchaseOrderStatus,
  QuotationStatus,
  RecordStatus,
  SalesOrderStatus,
  VendorBillStatus,
} from "@prisma/client";

/**
 * Trigger catalog: the only entities, audit actions and snapshot fields a workflow may use.
 * A trigger is an audit-log action (written by the module's service); conditions and
 * {{templates}} read fields of that audit row's `next` snapshot plus `id` (the record id).
 *
 * Snapshots differ by action: `*.created` carries the whole record, transitions carry only
 * what changed (usually `status` plus the action's inputs, e.g. `reason`). A condition on a
 * field the snapshot does not carry is simply false (see conditions.ts).
 *
 * Leads write only `lead.converted` to the audit log (other lead history lives in lead
 * activities), so that is the one lead trigger. "workflow.*" and "approval.*" actions,
 * written by this engine, are never triggers.
 */

export type FieldType = "string" | "number" | "decimal" | "boolean" | "date";
export type FieldDef = { type: FieldType; options?: readonly string[] };
export type EntityDef = { label: string; actions: readonly string[]; fields: Record<string, FieldDef> };

const s: FieldDef = { type: "string" };
const n: FieldDef = { type: "number" };
const d: FieldDef = { type: "decimal" };
const b: FieldDef = { type: "boolean" };
const t: FieldDef = { type: "date" };
const e = (options: Record<string, string> | readonly string[]): FieldDef => ({ type: "string", options: Object.values(options) });

const on = (entity: string, ...verbs: string[]) => verbs.map((v) => `${entity}.${v}`);

export const TRIGGER_CATALOG: Record<string, EntityDef> = {
  lead: {
    label: "Lead",
    actions: ["lead.converted"],
    fields: { status: e(LeadStatus), customerId: s, contactId: s, opportunityId: s },
  },
  customer: {
    label: "Customer",
    actions: on("customer", "created", "updated", "archived"),
    fields: { name: s, type: e(CustomerType), email: s, phone: s, gstin: s, stateCode: s, paymentTermsDays: n, creditLimit: d, ownerUserId: s, status: e(RecordStatus), createdById: s },
  },
  opportunity: {
    label: "Opportunity",
    actions: on("opportunity", "created", "updated", "stage_changed"),
    fields: { name: s, stage: e(OpportunityStage), probability: n, amount: d, currency: s, expectedCloseDate: t, ownerUserId: s, customerId: s, lossReason: s, createdById: s },
  },
  quotation: {
    label: "Quotation",
    actions: on("quotation", "created", "updated", "submit", "approve", "return", "send", "accept", "reject", "cancel", "revised", "converted", "expired"),
    fields: { number: s, status: e(QuotationStatus), customerId: s, subtotal: d, taxTotal: d, grandTotal: d, currency: s, validUntil: t, approvalRequired: b, revision: n, reason: s, createdById: s },
  },
  sales_order: {
    label: "Sales order",
    actions: on("sales_order", "created", "confirmed", "cancelled", "reserved"),
    fields: { number: s, status: e(SalesOrderStatus), customerId: s, grandTotal: d, currency: s, orderDate: t, expectedDeliveryDate: t, reason: s, createdById: s },
  },
  purchase_order: {
    label: "Purchase order",
    actions: on("purchase_order", "created", "updated", "submit", "approve", "return", "cancel", "close"),
    fields: { number: s, status: e(PurchaseOrderStatus), vendorId: s, grandTotal: d, currency: s, orderDate: t, expectedDate: t, approvalRequired: b, reason: s, createdById: s },
  },
  vendor_bill: {
    label: "Vendor bill",
    actions: on("vendor_bill", "created", "approved", "posted", "cancelled"),
    fields: { number: s, vendorInvoiceNumber: s, status: e(VendorBillStatus), vendorId: s, purchaseOrderId: s, grandTotal: d, billDate: t, dueDate: t, reason: s, createdById: s },
  },
  sales_invoice: {
    label: "Sales invoice",
    actions: on("invoice", "created", "updated", "posted", "cancelled"),
    fields: { number: s, status: e(FinanceDocStatus), customerId: s, grandTotal: d, paidAmount: d, invoiceDate: t, dueDate: t, reason: s, createdById: s },
  },
  expense_claim: {
    label: "Expense claim",
    actions: on("expense_claim", "created", "updated", "submit", "approve", "reject", "cancel", "pay"),
    fields: { number: s, title: s, status: e(ExpenseClaimStatus), totalAmount: d, total: d, claimantId: s, reason: s },
  },
  ticket: {
    label: "Service ticket",
    actions: on("ticket", "created", "updated", "assign", "start", "hold", "resolve", "close", "reopen", "cancel", "feedback", "escalated"),
    fields: {
      number: s, subject: s, priority: e(LeadPriority), status: e(["NEW", "OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED", "CANCELLED"]),
      source: s, customerId: s, categoryId: s, assigneeId: s, escalationLevel: n, resolutionCode: s, rating: n, reason: s, createdById: s,
    },
  },
  leave_request: {
    label: "Leave request",
    actions: on("leave_request", "applied", "approve", "reject", "cancel"),
    fields: { status: e(ApprovalStatus), days: d, startDate: t, endDate: t, leaveType: s, reason: s },
  },
  work_order: {
    label: "Work order",
    actions: on("work_order", "created", "release", "reserve", "start", "complete", "cancel", "materials_issued", "goods_received"),
    fields: { number: s, status: e(["DRAFT", "RELEASED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]), productId: s, quantity: d, producedQty: d, plannedStart: t, plannedEnd: t, salesOrderId: s, reason: s, createdById: s },
  },
};

/** Fields of an entity usable in conditions and templates (always includes `id`). */
export function entityFields(entity: string): Record<string, FieldDef> | null {
  const def = TRIGGER_CATALOG[entity];
  return def ? { id: s, ...def.fields } : null;
}

/** Snapshot fields tried, in order, by notify_record_owner. */
export const OWNER_FIELDS = ["ownerUserId", "assigneeId", "claimantId", "createdById"] as const;
