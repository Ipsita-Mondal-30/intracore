import { api } from "@/lib/api/http";
import { getDispatch } from "@/features/service/dispatch";

export const GET = api<{ id: string }>((ctx, { params }) => getDispatch(ctx, params.id));
