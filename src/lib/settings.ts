import { z } from "zod";

/**
 * Typed views over the JSON `settings` columns. Missing keys fall back to defaults,
 * so new settings never need a data migration.
 */
export const companySettingsSchema = z.object({
  quotation: z
    .object({
      /** Any line discount above this percent needs approval. */
      approvalDiscountPercent: z.number().min(0).max(100).default(10),
      /** Grand total above this needs approval (null = no value threshold). */
      approvalAmount: z.number().nonnegative().nullable().default(null),
      defaultValidityDays: z.number().int().min(1).max(365).default(30),
    })
    .default({}),
  purchase: z
    .object({
      /** Purchase orders above this grand total need approval (null = always auto-approve). */
      approvalAmount: z.number().nonnegative().nullable().default(null),
      /** Vendor bills above this grand total need approval before posting (null = none). */
      billApprovalAmount: z.number().nonnegative().nullable().default(null),
    })
    .default({}),
  finance: z
    .object({
      /** Journals are only generated once finance is set up for the company. */
      enabled: z.boolean().default(false),
      /** yyyy-mm-dd; documents dated earlier are operational only (no journal). */
      accountingStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
      /** 4 = April (India). Used for fiscal years and {FY} in document numbers. */
      fiscalYearStartMonth: z.number().int().min(1).max(12).default(4),
    })
    .default({}),
  receivables: z
    .object({
      defaultPaymentTermsDays: z.number().int().min(0).max(365).default(30),
      /** Overdue invoices are re-notified at most this often. */
      reminderIntervalDays: z.number().int().min(1).max(90).default(7),
    })
    .default({}),
  gst: z
    .object({
      /** Inter-state B2C invoices above this value are reported individually (B2CL).
       *  Verify the current threshold with your accountant before filing. */
      b2clThreshold: z.number().nonnegative().default(100000),
    })
    .default({}),
  inventory: z
    .object({
      /** Documented policy switch; off means outbound moves can never go below zero. */
      allowNegativeStock: z.boolean().default(false),
    })
    .default({}),
});

export type CompanySettings = z.infer<typeof companySettingsSchema>;

export const orgSettingsSchema = z.object({
  duplicates: z
    .object({
      lead: z.array(z.enum(["email", "phone", "whatsapp", "company"])).default(["email", "phone", "whatsapp", "company"]),
      customer: z.array(z.enum(["gstin", "email", "phone", "name"])).default(["gstin", "email", "phone"]),
    })
    .default({}),
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export function companySettings(raw: unknown): CompanySettings {
  const parsed = companySettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : companySettingsSchema.parse({});
}

export function orgSettings(raw: unknown): OrgSettings {
  const parsed = orgSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : orgSettingsSchema.parse({});
}
