import { api } from "@/lib/api/http";
import { getInspection } from "@/features/quality/inspections";

export const GET = api<{ id: string }>((ctx, { params }) => getInspection(ctx, params.id));
