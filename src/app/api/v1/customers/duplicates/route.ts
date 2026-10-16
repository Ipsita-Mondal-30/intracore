import { api } from "@/lib/api/http";
import { assertCan } from "@/lib/access";
import { findDuplicateCustomers } from "@/features/customers/service";

/** ?gstin=&email=&phone=&name= — matches under the organization's duplicate rules. */
export const GET = api(async (ctx, { query }) => {
  assertCan(ctx, "customer.view");
  return findDuplicateCustomers(ctx.organizationId, {
    gstin: query.get("gstin"),
    email: query.get("email"),
    phone: query.get("phone"),
    name: query.get("name"),
  });
});
