import { api } from "@/lib/api/http";
import { getAsset, updateAsset } from "@/features/service/assets";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getAsset(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateAsset(ctx, params.id, body));
