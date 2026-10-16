import { portalApi, dealerOnly } from "@/features/portal/http";
import { createOrderRequest, listOrderRequests } from "@/features/portal/dealer";

export const GET = portalApi<{ portal: string }>(dealerOnly, (p) => listOrderRequests(p));
export const POST = portalApi<{ portal: string }>(dealerOnly, (p, { body }) => createOrderRequest(p, body), { status: 201, idempotent: true });
