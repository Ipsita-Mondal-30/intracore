import { api } from "@/lib/api/http";
import { listRetentionPolicies } from "@/features/admin/retention";

export const GET = api((ctx) => listRetentionPolicies(ctx));
