import { api } from "@/lib/api/http";
import { getContract, updateContract } from "@/features/service/contracts";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getContract(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateContract(ctx, params.id, body));
