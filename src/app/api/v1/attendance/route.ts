import { api, queryObject } from "@/lib/api/http";
import { listAttendance, recordAttendance } from "@/features/hr/attendance";

export const GET = api((ctx, { query }) => listAttendance(ctx, queryObject(query)));
/** { date, entries: [{ employeeId, status, checkIn?, checkOut?, notes? }] } */
export const POST = api((ctx, { body }) => recordAttendance(ctx, body), { idempotent: true });
