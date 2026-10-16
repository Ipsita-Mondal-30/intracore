import { api } from "@/lib/api/http";
import { createUom } from "@/features/catalog/service";

export const POST = api((ctx, { body }) => createUom(ctx, body), { status: 201, idempotent: true });
