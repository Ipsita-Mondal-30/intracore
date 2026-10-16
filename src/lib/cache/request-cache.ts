import { cache } from "react";
import { revalidateTag, unstable_cache } from "next/cache";

/** Per-request deduplication (same render pass). */
export { cache as requestCache };

/**
 * Cross-request cache (Next data cache: shared by all server instances, invalidated by tag).
 * Outside a Next request (tests, scripts) there is no cache store, so it just calls `fn`.
 * Results are JSON-serialized: return plain data (no Date/Set/Map).
 */
export async function sharedCache<T>(
  fn: () => Promise<T>,
  key: string[],
  options: { tags: string[]; revalidate: number },
): Promise<T> {
  try {
    return await unstable_cache(fn, key, options)();
  } catch (error) {
    if (error instanceof Error && error.message.includes("incrementalCache missing")) return fn();
    throw error;
  }
}

/** Invalidate cached entries by tag. A no-op outside a Next request (nothing is cached there). */
export function invalidateTags(...tags: string[]) {
  for (const tag of tags) {
    try {
      revalidateTag(tag);
    } catch {
      // no request store (tests, scripts)
    }
  }
}

/** Cross-request cache for org-scoped read-mostly data. */
export function orgCache<T>(
  key: string,
  organizationId: string,
  fn: () => Promise<T>,
  revalidateSeconds = 120,
) {
  return sharedCache(fn, [`${key}:${organizationId}`], {
    revalidate: revalidateSeconds,
    tags: [`${key}:${organizationId}`],
  });
}

/**
 * Access data (user row, membership, role permissions, company scopes) is cached for at most
 * ACCESS_TTL seconds and invalidated on every write that changes it. The TTL bounds staleness
 * if a change ever bypasses invalidation (e.g. a manual SQL edit).
 */
export const ACCESS_TTL = 60;
export const accessTag = (organizationId: string) => `access:${organizationId}`;
export const userTag = (userId: string) => `user:${userId}`;

/** Call after a committed write to memberships, roles, role permissions, scopes or companies. */
export function invalidateAccess(organizationId: string) {
  invalidateTags(accessTag(organizationId));
}

/** Call after a committed write to a user row (profile, active organization). */
export function invalidateUser(userId: string) {
  invalidateTags(userTag(userId));
}

/** Runs `invalidate` only after `promise` resolves, i.e. after the transaction committed. */
export async function afterCommit<T>(promise: Promise<T>, invalidate: () => void): Promise<T> {
  const result = await promise;
  invalidate();
  return result;
}
