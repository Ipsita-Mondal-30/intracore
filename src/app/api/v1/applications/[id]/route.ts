import { api } from "@/lib/api/http";
import { getApplication } from "@/features/hr/recruitment";

export const GET = api<{ id: string }>((ctx, { params }) => getApplication(ctx, params.id));
