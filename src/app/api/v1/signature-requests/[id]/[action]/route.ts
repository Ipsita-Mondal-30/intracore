import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { refreshSignatureRequest, sendSignatureRequest, voidSignatureRequest } from "@/features/documents/esign";

type P = { id: string; action: string };
/** There is deliberately no action that marks a request SIGNED: only the provider can. */
const ACTIONS = { send: sendSignatureRequest, void: voidSignatureRequest, refresh: refreshSignatureRequest };

export const POST = api<P>((ctx, { params }) => {
  const run = Object.prototype.hasOwnProperty.call(ACTIONS, params.action) ? ACTIONS[params.action as keyof typeof ACTIONS] : null;
  if (!run) throw new AppError("NOT_FOUND", "Unknown action", 404);
  return run(ctx, params.id);
});
