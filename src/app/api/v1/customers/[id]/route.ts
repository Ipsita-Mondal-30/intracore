import { api } from "@/lib/api/http";
import { getCustomer, updateCustomer } from "@/features/customers/service";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getCustomer(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateCustomer(ctx, params.id, body));
