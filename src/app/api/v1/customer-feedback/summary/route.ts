import { api, queryObject } from "@/lib/api/http";
import { feedbackSummary } from "@/features/marketing/feedback";

export const GET = api((ctx, { query }) => feedbackSummary(ctx, queryObject(query)));
