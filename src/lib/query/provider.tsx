"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";

/**
 * Client data cache for everything fetched from the browser:
 * - data is fresh for 30 s, then served from cache while it refetches in the background;
 * - refetches when the tab regains focus or the network reconnects;
 * - unused entries are dropped after 10 min;
 * - 4xx answers (validation, permission, not found) are never retried.
 * Mutations (ApiForm, ActionButton, useApiMutation) invalidate the cache — see hooks.ts.
 * Nothing is persisted to localStorage: ERP data must not outlive the session on shared machines.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 10 * 60_000,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
