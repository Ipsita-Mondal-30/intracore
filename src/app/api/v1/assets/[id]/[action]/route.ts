import { api } from "@/lib/api/http";
import { transitionAsset } from "@/features/service/assets";

/** POST /assets/:id/{in-use|in-stock|repair|retire|dispose} */
export const POST = api<{ id: string; action: string }>((ctx, { params, body }) => transitionAsset(ctx, params.id, params.action, body), { idempotent: true });
