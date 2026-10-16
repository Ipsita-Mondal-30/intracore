import { api } from "@/lib/api/http";
import { getEnvironmentStatus } from "@/features/admin/settings";

export const GET = api((ctx) => getEnvironmentStatus(ctx));
