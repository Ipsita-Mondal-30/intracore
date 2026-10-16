import { api } from "@/lib/api/http";
import { deleteSegment, getSegment, updateSegment } from "@/features/marketing/segments";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getSegment(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateSegment(ctx, params.id, body));
export const DELETE = api<P>((ctx, { params }) => deleteSegment(ctx, params.id));
