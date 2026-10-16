import { api, queryObject } from "@/lib/api/http";
import { listApprovals } from "@/features/automation/approvals";

export const GET = api((ctx, { query }) => listApprovals(ctx, queryObject(query)));
