import { api } from "@/lib/api/http";
import { getInvoice, updateInvoice } from "@/features/finance/receivables";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getInvoice(ctx, params.id));
/** Drafts only. */
export const PATCH = api<P>((ctx, { params, body }) => updateInvoice(ctx, params.id, body));
