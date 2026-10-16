import { api } from "@/lib/api/http";
import { updateNumberSequence } from "@/features/companies/service";

export const PATCH = api<{ id: string; type: string }>((ctx, { params, body }) =>
  updateNumberSequence(ctx, params.id, params.type, body),
);
