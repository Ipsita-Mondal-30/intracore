import { api, queryObject } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { CAMPAIGN_ACTIONS, getCampaign, listCampaignRecipients, transitionCampaign, type CampaignAction } from "@/features/marketing/campaigns";

type P = { id: string; action: string };

/** GET /campaigns/:id/{metrics|recipients} */
export const GET = api<P>(async (ctx, { params, query }) => {
  if (params.action === "metrics") return (await getCampaign(ctx, params.id)).metrics;
  if (params.action === "recipients") return listCampaignRecipients(ctx, params.id, queryObject(query));
  throw new AppError("NOT_FOUND", "Unknown campaign resource", 404);
});

/** POST /campaigns/:id/{submit|approve|reject|schedule|send|cancel} */
export const POST = api<P>(
  (ctx, { params, body }) => {
    if (!CAMPAIGN_ACTIONS.includes(params.action as CampaignAction)) throw new AppError("NOT_FOUND", "Unknown campaign action", 404);
    return transitionCampaign(ctx, params.id, params.action as CampaignAction, body);
  },
  { idempotent: true },
);
