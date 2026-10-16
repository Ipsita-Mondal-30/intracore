import { api } from "@/lib/api/http";
import { getQuotation, updateQuotation } from "@/features/sales/quotations";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getQuotation(ctx, params.id));
/** Drafts only. */
export const PATCH = api<P>((ctx, { params, body }) => updateQuotation(ctx, params.id, body));
