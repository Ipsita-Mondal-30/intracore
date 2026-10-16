import { api } from "@/lib/api/http";
import { previewSegment } from "@/features/marketing/segments";

/** POST { segmentId } or { entity, filters }, plus { channel, purpose? } → audience counts and a sample. */
export const POST = api((ctx, { body }) => previewSegment(ctx, body));
