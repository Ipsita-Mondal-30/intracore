import { api, queryObject } from "@/lib/api/http";
import { listJobRuns } from "@/features/integrations/jobs";

export const GET = api((ctx, { query }) => listJobRuns(ctx, queryObject(query)));
