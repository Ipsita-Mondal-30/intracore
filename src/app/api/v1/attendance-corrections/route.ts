import { api, queryObject } from "@/lib/api/http";
import { listCorrections, requestCorrection } from "@/features/hr/attendance";

export const GET = api((ctx, { query }) => listCorrections(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => requestCorrection(ctx, body), { status: 201, idempotent: true });
