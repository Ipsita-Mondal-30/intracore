import { api, queryObject } from "@/lib/api/http";
import { listAuditLogs } from "@/features/audit/service";

export const GET = api((ctx, { query }) => listAuditLogs(ctx, queryObject(query)));
