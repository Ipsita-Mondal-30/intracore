import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { hasSupabasePublicEnv } from "@/lib/config/env";
import { createClient } from "@/lib/supabase/server";

/** The verified identity of the request: what pages and APIs need from Supabase Auth. */
export type AuthUser = Pick<User, "id" | "email" | "user_metadata"> & { email_confirmed_at?: string };

/**
 * Verifies the session JWT locally with the project's asymmetric signing key (JWKS is cached
 * process-wide by supabase-js), refreshing an expired session via the refresh token. This
 * avoids the Auth-server round trip `getUser()` makes on every request; with a legacy
 * symmetric (HS256) project, supabase-js falls back to `getUser()` internally.
 */
async function loadSupabaseAuthUser(): Promise<AuthUser | null> {
  if (!hasSupabasePublicEnv()) {
    return null;
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims?.sub) return null;
    const { sub, email, user_metadata } = data.claims;
    return { id: sub, email, user_metadata: user_metadata ?? {} };
  } catch (error) {
    console.error("getSupabaseAuthUser failed", error);
    return null;
  }
}

/** Request-scoped so layout + tenant share one verification. */
export const getSupabaseAuthUser = cache(loadSupabaseAuthUser);
