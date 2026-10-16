import { api, queryObject } from "@/lib/api/http";
import { createSupplierEvaluation, listSupplierEvaluations } from "@/features/quality/suppliers";

export const GET = api((ctx, { query }) => listSupplierEvaluations(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createSupplierEvaluation(ctx, body), { status: 201, idempotent: true });
