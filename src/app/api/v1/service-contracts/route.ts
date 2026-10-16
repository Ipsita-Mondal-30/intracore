import { api, queryObject } from "@/lib/api/http";
import { createContract, listContracts } from "@/features/service/contracts";

export const GET = api((ctx, { query }) => listContracts(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createContract(ctx, body), { status: 201, idempotent: true });
