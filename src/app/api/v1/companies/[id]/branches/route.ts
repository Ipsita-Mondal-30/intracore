import { api } from "@/lib/api/http";
import { createBranch } from "@/features/companies/service";

export const POST = api<{ id: string }>(
  (ctx, { params, body }) => createBranch(ctx, params.id, body),
  { status: 201, idempotent: true },
);
