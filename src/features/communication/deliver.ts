import type { BackgroundJob } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { sanitizeError } from "@/lib/sanitize";
import { activeIntegration, providerSettings } from "@/features/integrations/service";
import { getProvider, ProviderError } from "./providers";

/**
 * Queue handler "communication.deliver". Idempotent: only a QUEUED log is sent.
 * - permanent failures (no enabled integration → NOT_CONFIGURED, provider 4xx, bad template)
 *   mark the log FAILED and return normally, so the job SUCCEEDS and is not retried;
 * - transient failures (timeouts, network, 5xx, 429) record the error and throw, so the queue
 *   retries with backoff; on the last attempt the log is marked FAILED and the job goes DEAD
 *   (replaying the DEAD job re-queues the log — see features/integrations/jobs.ts).
 */
export async function deliverMessage(payload: { logId: string; variables?: Record<string, string> }, job?: BackgroundJob): Promise<unknown> {
  const log = await prisma.communicationLog.findUnique({ where: { id: payload.logId }, include: { template: true } });
  if (!log || log.direction !== "OUTBOUND") return { skipped: "NOT_FOUND" };
  if (log.status !== "QUEUED") return { skipped: log.status };

  await prisma.communicationLog.update({ where: { id: log.id }, data: { attempts: { increment: 1 } } });
  const fail = async (error: string, code: string) => {
    await prisma.communicationLog.updateMany({ where: { id: log.id, status: "QUEUED" }, data: { status: "FAILED", error, failedAt: new Date() } });
    return { status: "FAILED", code };
  };

  const integration = await activeIntegration(prisma, log.organizationId, log.channel);
  const provider = integration ? getProvider(integration.provider) : null;
  if (!integration || !provider) return fail(`NOT_CONFIGURED: no enabled ${log.channel} integration`, "NOT_CONFIGURED");

  try {
    const { providerMessageId } = await provider.send(
      {
        id: log.id,
        to: log.toAddress,
        subject: log.subject,
        body: log.body,
        template: log.template ? { providerTemplateName: log.template.providerTemplateName, language: log.template.language, variables: log.template.variables } : null,
        variables: payload.variables ?? {},
      },
      providerSettings(integration),
    );
    await prisma.communicationLog.updateMany({
      where: { id: log.id, status: "QUEUED" },
      data: { status: "SENT", provider: provider.key, providerMessageId, simulated: provider.simulated, sentAt: new Date(), error: null },
    });
    return { status: "SENT", provider: provider.key, simulated: provider.simulated };
  } catch (error) {
    const message = sanitizeError(error);
    if (error instanceof ProviderError && error.permanent) return fail(`${error.code}: ${message}`, error.code);
    const lastAttempt = job ? job.attempts >= job.maxAttempts : false;
    if (lastAttempt) await fail(`Retries exhausted: ${message}`, "RETRIES_EXHAUSTED");
    else await prisma.communicationLog.update({ where: { id: log.id }, data: { error: message, provider: provider.key } });
    throw error;
  }
}
