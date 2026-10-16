import { api, queryObject } from "@/lib/api/http";
import { customerStatement } from "@/features/finance/reports";

export const GET = api<{ id: string; partyId: string }>((ctx, { params, query }) =>
  customerStatement(ctx, params.id, params.partyId, queryObject(query)),
);
