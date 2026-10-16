import { api } from "@/lib/api/http";
import { getCompany, updateCompany } from "@/features/companies/service";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getCompany(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateCompany(ctx, params.id, body));
