import { api } from "@/lib/api/http";
import { createTaxRate } from "@/features/catalog/service";

export const POST = api((ctx, { body }) => createTaxRate(ctx, body), { status: 201, idempotent: true });
