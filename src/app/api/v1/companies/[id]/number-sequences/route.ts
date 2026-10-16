import { api } from "@/lib/api/http";
import { listNumberSequences } from "@/features/companies/service";

export const GET = api<{ id: string }>((ctx, { params }) => listNumberSequences(ctx, params.id));
