import { api } from "@/lib/api/http";
import { createDesignation, listDesignations } from "@/features/hr/org";

export const GET = api((ctx) => listDesignations(ctx));
export const POST = api((ctx, { body }) => createDesignation(ctx, body), { status: 201, idempotent: true });
