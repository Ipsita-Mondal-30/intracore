import { api, queryObject } from "@/lib/api/http";
import { vendorStatement } from "@/features/finance/reports";

export const GET = api<{ id: string; partyId: string }>((ctx, { params, query }) =>
  vendorStatement(ctx, params.id, params.partyId, queryObject(query)),
);
