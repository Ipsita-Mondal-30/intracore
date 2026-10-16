import { api } from "@/lib/api/http";
import { getVendor, updateVendor } from "@/features/purchasing/vendors";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getVendor(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateVendor(ctx, params.id, body));
