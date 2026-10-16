import { api } from "@/lib/api/http";
import { replayWebhookEvent } from "@/features/integrations/jobs";

export const POST = api<{ id: string }>((ctx, { params }) => replayWebhookEvent(ctx, params.id), { idempotent: true });
