import { api } from "@/lib/api/http";
import { getCampaign, updateCampaign } from "@/features/marketing/campaigns";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getCampaign(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateCampaign(ctx, params.id, body));
