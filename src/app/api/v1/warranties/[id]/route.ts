import { api } from "@/lib/api/http";
import { getWarranty, updateWarranty } from "@/features/service/assets";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getWarranty(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateWarranty(ctx, params.id, body));
