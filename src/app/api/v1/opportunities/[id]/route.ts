import { api } from "@/lib/api/http";
import { getOpportunity, updateOpportunity } from "@/features/opportunities/service";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getOpportunity(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateOpportunity(ctx, params.id, body));
