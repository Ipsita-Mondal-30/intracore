import { vi } from "vitest";
import { prisma } from "@/lib/db/prisma";

/**
 * Route-level auth for tests: point the mocked Supabase session at a user id
 * (or null for an anonymous request). Requires in the test file:
 *   vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));
 */
export async function signInAs(userId: string | null) {
  const { getSupabaseAuthUser } = await import("@/lib/auth/supabase-user");
  const user = userId ? await prisma.user.findUniqueOrThrow({ where: { id: userId } }) : null;
  vi.mocked(getSupabaseAuthUser).mockResolvedValue(
    user ? ({ id: user.id, email: user.email, user_metadata: { name: user.name } } as never) : null,
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route handlers declare differing param shapes
type Handler = (req: Request, route: { params: Promise<any> }) => Promise<Response>;

export async function call(
  handler: Handler,
  init: { method?: string; body?: unknown; params?: Record<string, string>; query?: string; headers?: Record<string, string> } = {},
) {
  const req = new Request(`http://test.local/api${init.query ? `?${init.query}` : ""}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const res = await handler(req, { params: Promise.resolve(init.params ?? {}) });
  return { status: res.status, headers: res.headers, json: await res.json() };
}
