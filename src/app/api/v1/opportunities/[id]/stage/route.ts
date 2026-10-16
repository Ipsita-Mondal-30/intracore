import { api } from "@/lib/api/http";
import { changeOpportunityStage } from "@/features/opportunities/service";

/** { stage, lossReason? (required for LOST), probability? } */
export const POST = api<{ id: string }>((ctx, { params, body }) => changeOpportunityStage(ctx, params.id, body));
