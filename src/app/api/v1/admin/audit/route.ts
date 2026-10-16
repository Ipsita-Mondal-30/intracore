import { api, queryObject } from "@/lib/api/http";
import { searchAuditLogs } from "@/features/admin/audit";

export const GET = api((ctx, { query }) => searchAuditLogs(ctx, queryObject(query)));
