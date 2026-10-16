import { api } from "@/lib/api/http";
import { getInterview } from "@/features/hr/recruitment";

export const GET = api<{ id: string }>((ctx, { params }) => getInterview(ctx, params.id));
