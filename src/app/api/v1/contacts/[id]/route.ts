import { api } from "@/lib/api/http";
import { getContact, updateContact } from "@/features/customers/service";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getContact(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateContact(ctx, params.id, body));
