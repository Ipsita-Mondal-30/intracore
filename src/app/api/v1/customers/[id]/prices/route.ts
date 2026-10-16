import { api } from "@/lib/api/http";
import { listCustomerPrices, setCustomerPrices } from "@/features/catalog/service";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => listCustomerPrices(ctx, params.id));
/** { prices: [{ productId, unitPrice | null }] } — null removes the override. */
export const PUT = api<P>((ctx, { params, body }) => setCustomerPrices(ctx, params.id, body));
