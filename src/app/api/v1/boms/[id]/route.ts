import { api } from "@/lib/api/http";
import { getBom, updateBom } from "@/features/manufacturing/boms";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getBom(ctx, params.id));
/** Drafts only. */
export const PATCH = api<P>((ctx, { params, body }) => updateBom(ctx, params.id, body));
