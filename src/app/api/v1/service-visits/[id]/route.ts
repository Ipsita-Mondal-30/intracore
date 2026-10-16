import { api } from "@/lib/api/http";
import { getVisit, updateVisit } from "@/features/service/field";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getVisit(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateVisit(ctx, params.id, body));
