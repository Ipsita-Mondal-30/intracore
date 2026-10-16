import { api } from "@/lib/api/http";
import { createCompany, listCompanies } from "@/features/companies/service";

export const GET = api((ctx) => listCompanies(ctx));
export const POST = api((ctx, { body }) => createCompany(ctx, body), { status: 201, idempotent: true });
