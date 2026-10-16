import { api, queryObject } from "@/lib/api/http";
import { createSignatureRequest, listSignatureRequests } from "@/features/documents/esign";

/** ?documentId= (required) */
export const GET = api((ctx, { query }) => listSignatureRequests(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createSignatureRequest(ctx, body), { status: 201, idempotent: true });
