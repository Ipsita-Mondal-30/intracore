import { api, queryObject } from "@/lib/api/http";
import { listWebhookEvents } from "@/features/integrations/jobs";

export const GET = api((ctx, { query }) => listWebhookEvents(ctx, queryObject(query)));
