import { api } from "@/lib/api/http";
import { getNonConformance, updateNonConformance } from "@/features/quality/ncr";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getNonConformance(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateNonConformance(ctx, params.id, body));
