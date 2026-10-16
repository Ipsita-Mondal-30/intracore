import { portalApi } from "@/features/portal/http";
import { listBills, submitInvoice } from "@/features/portal/vendor";

export const GET = portalApi("VENDOR", (p, { query }) => listBills(p, Object.fromEntries(query)));
/** Submit an invoice: creates a DRAFT vendor bill for internal review. */
export const POST = portalApi("VENDOR", (p, { body }) => submitInvoice(p, body), { status: 201, idempotent: true });
