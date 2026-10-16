import { purgeExpiredIdempotencyKeys } from "@/lib/api/idempotency";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { processQueue } from "@/lib/queue";
import { sanitizeError } from "@/lib/sanitize";
import { sendFollowUpReminderEmails } from "@/lib/email/follow-up-reminders";
import { processDueTaskReminders } from "@/features/tasks/service";
import { expireQuotations } from "@/features/sales/quotations";
import { sendLowStockAlerts } from "@/features/inventory/alerts";
import { remindOverdueInvoices } from "@/features/finance/receivables";
import { escalateOverdueTickets } from "@/features/service/sla";
import { expireServiceContracts, sendContractAndWarrantyReminders } from "@/features/service/contracts";
import { processReminders } from "@/features/notifications/reminders";
import { dispatchWorkflows } from "@/features/automation/engine";
import { escalateApprovals } from "@/features/automation/approvals";
import { startDueCampaigns } from "@/features/marketing/campaigns";
import { expireLoyaltyPoints } from "@/features/marketing/loyalty";

/**
 * Background jobs. Each is idempotent and safe to run on any schedule; the runner is
 * triggered by POST/GET /api/v1/jobs/run with `Authorization: Bearer $CRON_SECRET`
 * (Vercel Cron, Supabase pg_cron + pg_net, or any external scheduler).
 */
export const JOBS: Record<string, () => Promise<unknown>> = {
  "task-reminders": () => processDueTaskReminders(),
  "follow-up-reminder-emails": () => sendFollowUpReminderEmails(),
  "idempotency-cleanup": () => purgeExpiredIdempotencyKeys(),
  "quotation-expiry": () => expireQuotations(),
  "low-stock-alerts": () => sendLowStockAlerts(),
  "overdue-invoice-reminders": () => remindOverdueInvoices(),
  "ticket-escalation": () => escalateOverdueTickets(),
  "service-contract-reminders": () => sendContractAndWarrantyReminders(),
  "service-contract-expiry": () => expireServiceContracts(),
  "background-queue": () => processQueue(),
  reminders: () => processReminders(),
  "workflow-dispatch": () => dispatchWorkflows(),
  "approval-escalation": () => escalateApprovals(),
  "campaign-scheduler": () => startDueCampaigns(),
  "loyalty-expiry": () => expireLoyaltyPoints(),
};

export async function runJobs(names: string[]) {
  const results: Record<string, unknown> = {};
  for (const name of names) {
    const run = await prisma.jobRun.create({ data: { name } });
    try {
      const result = await JOBS[name]();
      await prisma.jobRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", result: (result ?? Prisma.JsonNull) as Prisma.InputJsonValue, finishedAt: new Date() } });
      results[name] = { ok: true, result };
    } catch (error) {
      const message = sanitizeError(error);
      console.error(`[jobs] ${name} failed: ${message}`);
      await prisma.jobRun.update({ where: { id: run.id }, data: { status: "FAILED", error: message, finishedAt: new Date() } });
      results[name] = { ok: false, error: message };
    }
  }
  return results;
}
