import { api } from "@/lib/api/http";
import { assertCan } from "@/lib/access";
import { reportCatalog } from "@/features/reports/catalog";

/** Report builder allowlist, limited to entities the caller may read. */
export const GET = api(async (ctx) => {
  assertCan(ctx, "report.build");
  return reportCatalog(ctx);
});
