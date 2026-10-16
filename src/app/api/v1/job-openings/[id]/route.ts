import { api } from "@/lib/api/http";
import { getJobOpening, updateJobOpening } from "@/features/hr/recruitment";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getJobOpening(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateJobOpening(ctx, params.id, body));
