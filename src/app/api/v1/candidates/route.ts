import { api, queryObject } from "@/lib/api/http";
import { createCandidate, listCandidates } from "@/features/hr/recruitment";

export const GET = api((ctx, { query }) => listCandidates(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createCandidate(ctx, body), { status: 201, idempotent: true });
