import { api } from "@/lib/api/http";
import { getCandidate, updateCandidate } from "@/features/hr/recruitment";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getCandidate(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateCandidate(ctx, params.id, body));
