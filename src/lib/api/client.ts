/** Browser-side caller for /api/v1 (same-origin, cookie session). */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      // A fresh key per user action makes accidental double-submits/retries safe.
      ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: res.statusText, code: "HTTP" }));
  if (!json.ok) throw new ApiError(json.error, json.code, res.status, json.details);
  return json.data as T;
}
