import { api, queryObject } from "@/lib/api/http";
import { listPortalAccounts } from "@/features/portal/admin";

export const GET = api((ctx, { query }) => listPortalAccounts(ctx, queryObject(query)));
