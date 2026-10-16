import { api, queryObject } from "@/lib/api/http";
import { createCampaign, listCampaigns } from "@/features/marketing/campaigns";

export const GET = api((ctx, { query }) => listCampaigns(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createCampaign(ctx, body), { status: 201, idempotent: true });
