import { api } from "@/lib/api/http";
import { getPermissionMatrix } from "@/features/admin/roles";

export const GET = api((ctx) => getPermissionMatrix(ctx));
