import { api, queryObject } from "@/lib/api/http";
import { listMembers } from "@/features/admin/users";

export const GET = api((ctx, { query }) => listMembers(ctx, queryObject(query)));
