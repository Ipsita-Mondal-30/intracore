import { api } from "@/lib/api/http";
import { deleteManualJournal, getJournal, updateManualJournal } from "@/features/finance/journals";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getJournal(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateManualJournal(ctx, params.id, body));
export const DELETE = api<P>((ctx, { params }) => deleteManualJournal(ctx, params.id));
