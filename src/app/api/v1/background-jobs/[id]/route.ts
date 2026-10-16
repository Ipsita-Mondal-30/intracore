import { api } from "@/lib/api/http";
import { getBackgroundJob } from "@/features/integrations/jobs";

export const GET = api<{ id: string }>((ctx, { params }) => getBackgroundJob(ctx, params.id));
