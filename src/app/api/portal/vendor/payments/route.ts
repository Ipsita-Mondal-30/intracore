import { portalApi } from "@/features/portal/http";
import { listPayments } from "@/features/portal/vendor";

export const GET = portalApi("VENDOR", (p, { query }) => listPayments(p, Object.fromEntries(query)));
