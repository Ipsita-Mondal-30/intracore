import { api } from "@/lib/api/http";
import { updateChecklistItem } from "@/features/service/installations";

/** PATCH { done, note? } */
export const PATCH = api<{ id: string; itemId: string }>((ctx, { params, body }) => updateChecklistItem(ctx, params.id, params.itemId, body));
