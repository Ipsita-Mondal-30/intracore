import { api } from "@/lib/api/http";
import { getClaim } from "@/features/service/claims";

export const GET = api<{ id: string }>((ctx, { params }) => getClaim(ctx, params.id));
