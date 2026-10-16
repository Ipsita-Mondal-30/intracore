import type { BackgroundJob } from "@prisma/client";
import { deliverMessage } from "@/features/communication/deliver";
import { processWebhookEvent } from "@/features/integrations/webhooks";
import { dispatchCampaign } from "@/features/marketing/dispatch";
import { generateExport } from "@/features/reports/exports";

type Handler<P> = (payload: P, job: BackgroundJob) => Promise<unknown>;

/** Background job handlers by type. Every handler must be safe to run more than once. */
export const QUEUE_HANDLERS = {
  "communication.deliver": deliverMessage as Handler<{ logId: string }>,
  "webhook.process": processWebhookEvent as Handler<{ eventId: string }>,
  "campaign.dispatch": dispatchCampaign as Handler<{ campaignId: string }>,
  "export.generate": generateExport as Handler<{ exportId: string }>,
};
