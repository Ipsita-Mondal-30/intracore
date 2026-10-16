import { purgeExpiredIdempotencyKeys } from "@/lib/api/idempotency";
import { sendFollowUpReminderEmails } from "@/lib/email/follow-up-reminders";
import { processDueTaskReminders } from "@/features/tasks/service";
import { expireQuotations } from "@/features/sales/quotations";
import { sendLowStockAlerts } from "@/features/inventory/alerts";

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
};

export async function runJobs(names: string[]) {
  const results: Record<string, unknown> = {};
  for (const name of names) {
    try {
      results[name] = { ok: true, result: await JOBS[name]() };
    } catch (error) {
      console.error(`[jobs] ${name} failed`, error);
      results[name] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return results;
}
