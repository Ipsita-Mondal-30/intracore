import { api } from "@/lib/api/http";
import { setUomConversions } from "@/features/catalog/service";

/** { conversions: [{ uomId, factor }] } — 1 uomId = factor base units. */
export const PUT = api<{ id: string }>((ctx, { params, body }) => setUomConversions(ctx, params.id, body));
