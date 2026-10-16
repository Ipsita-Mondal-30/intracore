"use client";

import { useCallback, useContext } from "react";
import { useRouter } from "next/navigation";
import { QueryClientContext, useMutation, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";

/** Every /api/v1 GET is cached under ["api", path]. */
export const apiKey = (path: string) => ["api", path] as const;

/** Cached GET of an /api/v1 path (stale-while-revalidate, background refetch). */
export function useApiQuery<T>(path: string | null, options: Omit<UseQueryOptions<T>, "queryKey" | "queryFn"> = {}) {
  return useQuery<T>({
    queryKey: apiKey(path ?? ""),
    queryFn: () => apiFetch<T>(path!),
    enabled: path !== null && (options.enabled ?? true),
    ...options,
  });
}

/**
 * After any write: mark every cached API read stale (active ones refetch in the background)
 * and refresh the server-rendered page, which also clears Next's client router cache.
 * Works outside a QueryProvider too (then only the page refresh happens).
 */
export function useInvalidateAfterWrite() {
  const queryClient = useContext(QueryClientContext);
  const router = useRouter();
  return useCallback(() => {
    void queryClient?.invalidateQueries();
    router.refresh();
  }, [queryClient, router]);
}

/** Write to /api/v1 and invalidate on success. */
export function useApiMutation<T, V = unknown>(path: string, method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST") {
  const invalidate = useInvalidateAfterWrite();
  return useMutation<T, Error, V>({
    mutationFn: (body: V) => apiFetch<T>(path, { method, body }),
    onSuccess: invalidate,
  });
}
