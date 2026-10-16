import { api } from "@/lib/api/http";
import { getProduct, updateProduct } from "@/features/catalog/service";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getProduct(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateProduct(ctx, params.id, body));
