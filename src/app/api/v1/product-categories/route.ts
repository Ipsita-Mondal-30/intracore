import { api } from "@/lib/api/http";
import { createCategory } from "@/features/catalog/service";

export const POST = api((ctx, { body }) => createCategory(ctx, body), { status: 201, idempotent: true });
