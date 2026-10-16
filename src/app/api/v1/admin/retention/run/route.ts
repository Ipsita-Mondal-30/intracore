import { api } from "@/lib/api/http";
import { runRetentionNow } from "@/features/admin/retention";

export const POST = api((ctx) => runRetentionNow(ctx));
