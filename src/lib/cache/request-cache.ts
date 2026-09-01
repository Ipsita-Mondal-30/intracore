import { cache } from "react";
import { unstable_cache } from "next/cache";

/** Per-request deduplication (same render pass). */
export { cache as requestCache };

/** Cross-request cache for org-scoped read-mostly data. */
export function orgCache<T>(
  key: string,
  organizationId: string,
  fn: () => Promise<T>,
  revalidateSeconds = 120,
) {
  return unstable_cache(fn, [`${key}:${organizationId}`], {
    revalidate: revalidateSeconds,
    tags: [`${key}:${organizationId}`],
  })();
}
