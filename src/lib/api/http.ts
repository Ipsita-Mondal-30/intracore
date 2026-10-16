import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError, isAppError } from "@/lib/errors";
import { getAccessContext, type AccessContext } from "@/lib/access";
import { withIdempotency, type IdempotentResult } from "@/lib/api/idempotency";

/**
 * /api/v1 conventions
 *   success: { ok: true, data }
 *   failure: { ok: false, error, code, details? } with a matching HTTP status
 * Every handler runs with an authenticated AccessContext; permissions are enforced
 * by the service functions it calls (deny by default).
 */
export type ApiInput<P> = {
  req: Request;
  params: P;
  body: unknown;
  query: URLSearchParams;
};

type Handler<P> = (ctx: AccessContext, input: ApiInput<P>) => Promise<unknown>;

export function api<P = Record<string, never>>(
  handler: Handler<P>,
  options: { status?: number; idempotent?: boolean } = {},
) {
  return async (req: Request, route: { params: Promise<P> }) => {
    try {
      const ctx = await getAccessContext();
      // Multipart bodies are left unread for the handler (req.formData()).
      const multipart = req.headers.get("content-type")?.startsWith("multipart/");
      const raw = req.method === "GET" || req.method === "HEAD" || multipart ? "" : await req.text();
      const input: ApiInput<P> = {
        req,
        params: await route.params,
        body: raw ? parseJson(raw) : {},
        query: new URL(req.url).searchParams,
      };
      const run = async (): Promise<IdempotentResult> => ({
        status: options.status ?? 200,
        body: { ok: true, data: await handler(ctx, input) },
      });
      const result = options.idempotent
        ? await withIdempotency(ctx, req.headers.get("idempotency-key"), raw, run)
        : await run();
      return NextResponse.json(result.body, {
        status: result.status,
        headers: result.replayed ? { "idempotent-replayed": "true" } : undefined,
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function parseJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
}

export function errorResponse(error: unknown) {
  const { status, body } = describeError(error);
  if (status >= 500) console.error("[api]", error);
  return NextResponse.json(body, { status });
}

export function describeError(error: unknown): {
  status: number;
  body: { ok: false; error: string; code: string; details?: unknown };
} {
  if (isAppError(error)) {
    return {
      status: error.status,
      body: { ok: false, error: error.message, code: error.code, details: error.details },
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 422,
      body: {
        ok: false,
        error: error.issues[0]?.message ?? "Validation failed",
        code: "VALIDATION_ERROR",
        details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return { status: 409, body: { ok: false, error: "A record with these values already exists", code: "CONFLICT", details: error.meta } };
    }
    if (error.code === "P2003") {
      return { status: 422, body: { ok: false, error: "A referenced record does not exist", code: "INVALID_REFERENCE" } };
    }
    if (error.code === "P2025") {
      return { status: 404, body: { ok: false, error: "Not found", code: "NOT_FOUND" } };
    }
  }
  return { status: 500, body: { ok: false, error: "Internal error", code: "INTERNAL" } };
}

export function queryObject(query: URLSearchParams) {
  return Object.fromEntries(query.entries());
}
