import { portalRoute } from "@/features/portal/http";
import { requirePortalUser } from "@/features/portal/context";
import { acceptPortalInvitation } from "@/features/portal/admin";

/** POST { token }: signed-in user whose email matches the invitation. */
export const POST = portalRoute(async ({ body }) => ({
  status: 200,
  body: { ok: true, data: await acceptPortalInvitation(await requirePortalUser(), body) },
}));
