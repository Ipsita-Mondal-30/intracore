import { api } from "@/lib/api/http";
import { findMyEmployee } from "@/features/hr/employees";

/** The caller's own employee record, or null when the login is not linked to one. */
export const GET = api((ctx) => findMyEmployee(ctx));
