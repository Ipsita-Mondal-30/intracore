import { api } from "@/lib/api/http";
import { replayBackgroundJob } from "@/features/integrations/jobs";

export const POST = api<{ id: string }>((ctx, { params }) => replayBackgroundJob(ctx, params.id), { idempotent: true });
