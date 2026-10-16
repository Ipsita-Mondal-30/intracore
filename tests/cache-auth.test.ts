import { describe, expect, it, vi } from "vitest";
import { afterCommit, invalidateAccess, sharedCache } from "@/lib/cache/request-cache";

const getClaims = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getClaims } }) }));
vi.mock("@/lib/config/env", () => ({ hasSupabasePublicEnv: () => true }));

describe("shared cache outside a Next request", () => {
  it("calls through and still propagates errors", async () => {
    expect(await sharedCache(async () => 42, ["k"], { tags: ["t"], revalidate: 60 })).toBe(42);
    await expect(sharedCache(async () => { throw new Error("boom"); }, ["k2"], { tags: ["t"], revalidate: 60 })).rejects.toThrow("boom");
    expect(() => invalidateAccess("org")).not.toThrow();
  });

  it("invalidates only after the write committed", async () => {
    const calls: string[] = [];
    await afterCommit(Promise.resolve("ok").then((v) => (calls.push("commit"), v)), () => calls.push("invalidate"));
    expect(calls).toEqual(["commit", "invalidate"]);
    await expect(afterCommit(Promise.reject(new Error("rollback")), () => calls.push("never"))).rejects.toThrow();
    expect(calls).not.toContain("never");
  });
});

describe("session identity from verified JWT claims", () => {
  it("maps claims and rejects invalid sessions", async () => {
    const { getSupabaseAuthUser } = await import("@/lib/auth/supabase-user");
    getClaims.mockResolvedValueOnce({ data: { claims: { sub: "u1", email: "a@b.co", user_metadata: { name: "A" } } }, error: null });
    expect(await getSupabaseAuthUser()).toEqual({ id: "u1", email: "a@b.co", user_metadata: { name: "A" } });
  });

  it("returns null when verification fails", async () => {
    vi.resetModules();
    const { getSupabaseAuthUser } = await import("@/lib/auth/supabase-user");
    getClaims.mockResolvedValueOnce({ data: null, error: new Error("invalid signature") });
    expect(await getSupabaseAuthUser()).toBeNull();
  });
});
