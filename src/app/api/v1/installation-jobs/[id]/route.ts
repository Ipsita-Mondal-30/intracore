import { api } from "@/lib/api/http";
import { getInstallationJob, scheduleInstallationJob } from "@/features/service/installations";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getInstallationJob(ctx, params.id));
/** Assign technician + slot: { technicianId, scheduledStart, scheduledEnd, address?, notes? } */
export const PATCH = api<P>((ctx, { params, body }) => scheduleInstallationJob(ctx, params.id, body));
