import { api, queryObject } from "@/lib/api/http";
import { createContact, listContacts } from "@/features/customers/service";

export const GET = api((ctx, { query }) => listContacts(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createContact(ctx, body), { status: 201, idempotent: true });
