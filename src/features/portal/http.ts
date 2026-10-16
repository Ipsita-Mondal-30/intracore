import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { errorResponse } from "@/lib/api/http";
import { withIdempotency, type IdempotentResult } from "@/lib/api/idempotency";
import { getPortalContext, PORTAL_ORG_COOKIE, type PortalContext, type PortalKind } from "@/features/portal/context";

/**
 * /api/portal/** handlers. Same envelope and error mapping as the internal api()
 * ({ ok, data } / { ok:false, error, code }), but authorized only by a portal account:
 * 401 signed out, 403 no active portal account of this kind, 404 for foreign records.
 */
export type PortalInput<P> = { req: Request; params: P; body: unknown; query: URLSearchParams };

function parseJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
}

/** Organization choice for multi-organization users: ?portalOrg= (strict) or the portalOrg cookie (hint). */
export function portalOrgFrom(req: Request): { org: string | null; hint: boolean } {
  const fromQuery = new URL(req.url).searchParams.get(PORTAL_ORG_COOKIE);
  if (fromQuery) return { org: fromQuery, hint: false };
  const match = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${PORTAL_ORG_COOKIE}=`));
  return { org: match ? decodeURIComponent(match.slice(PORTAL_ORG_COOKIE.length + 1)) : null, hint: true };
}

/** Envelope + body parsing; `run` authenticates and returns the response. */
export function portalRoute<P = Record<string, never>>(run: (input: PortalInput<P>, raw: string) => Promise<IdempotentResult>) {
  return async (req: Request, route: { params: Promise<P> }) => {
    try {
      const raw = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      const input = { req, params: await route.params, body: raw ? parseJson(raw) : {}, query: new URL(req.url).searchParams };
      const r = await run(input, raw);
      return NextResponse.json(r.body, { status: r.status, headers: r.replayed ? { "idempotent-replayed": "true" } : undefined });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** `kind` may depend on the route params (customer and dealer share /api/portal/[portal]/…). */
export function portalApi<P = Record<string, never>>(
  kind: PortalKind | ((params: P) => PortalKind),
  handler: (p: PortalContext, input: PortalInput<P>) => Promise<unknown>,
  options: { status?: number; idempotent?: boolean } = {},
) {
  return portalRoute<P>(async (input, raw) => {
    const { org, hint } = portalOrgFrom(input.req);
    const p = await getPortalContext(typeof kind === "function" ? kind(input.params) : kind, org, hint);
    const run = async (): Promise<IdempotentResult> => ({ status: options.status ?? 200, body: { ok: true, data: await handler(p, input) } });
    return options.idempotent ? withIdempotency(p, input.req.headers.get("idempotency-key"), raw, run) : run();
  });
}

/** "customer" | "dealer" path segment → kind; anything else is 404. */
export function salesPortalKind(params: { portal: string }): PortalKind {
  if (params.portal === "customer") return "CUSTOMER";
  if (params.portal === "dealer") return "DEALER";
  throw new AppError("NOT_FOUND", "Not found", 404);
}

/** Dealer-only endpoints under /api/portal/[portal]/…: 404 on the customer portal. */
export function dealerOnly(params: { portal: string }): PortalKind {
  if (params.portal === "dealer") return "DEALER";
  throw new AppError("NOT_FOUND", "Not found", 404);
}
