import { api, queryObject } from "@/lib/api/http";
import { getCrmFunnel } from "@/features/crm/reports";

export const GET = api((ctx, { query }) => getCrmFunnel(ctx, queryObject(query)));
