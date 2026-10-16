import { portalApi } from "@/features/portal/http";
import { updateChecklistItem } from "@/features/portal/technician";

/** PATCH { done, note? } */
export const PATCH = portalApi<{ id: string; itemId: string }>("TECHNICIAN", (p, { params, body }) => updateChecklistItem(p, params.id, params.itemId, body));
