import { api } from "@/lib/api/http";
import { deleteTimeEntry, updateTimeEntry } from "@/features/projects/time";

type P = { id: string };
export const PATCH = api<P>((ctx, { params, body }) => updateTimeEntry(ctx, params.id, body));
export const DELETE = api<P>((ctx, { params }) => deleteTimeEntry(ctx, params.id));
