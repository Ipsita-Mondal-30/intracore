import type { CommunicationType } from "@prisma/client";

export type OutboundMessage = {
  /** our CommunicationLog id; used as the provider idempotency key where supported */
  id: string;
  to: string;
  subject: string | null;
  body: string;
  /** provider-approved template (WhatsApp); variables in declared order */
  template: { providerTemplateName: string | null; language: string; variables: string[] } | null;
  variables: Record<string, string>;
};

/** Decrypted secrets plus non-secret config of the org's integration. Never log this. */
export type ProviderSettings = { secrets: Record<string, string>; config: Record<string, string> };

export interface MessageProvider {
  key: string;
  channel: CommunicationType;
  /** the mock provider: never contacts anything */
  simulated: boolean;
  send(message: OutboundMessage, settings: ProviderSettings): Promise<{ providerMessageId: string }>;
  healthCheck(settings: ProviderSettings): Promise<void>;
}

/**
 * `permanent` errors (validation, rejected recipient, missing configuration) are recorded
 * as FAILED without retry; anything else is treated as transient and retried by the queue.
 */
export class ProviderError extends Error {
  constructor(message: string, public readonly permanent: boolean, public readonly code = "PROVIDER_ERROR") {
    super(message);
    this.name = "ProviderError";
  }
}

export const PROVIDER_TIMEOUT_MS = 10_000;

/** fetch with a timeout; maps HTTP failures to ProviderError (4xx permanent except 408/429). */
export async function providerFetch(url: string, init: RequestInit, describe: (json: unknown) => string | undefined) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ProviderError(timeout ? `Timed out after ${PROVIDER_TIMEOUT_MS} ms` : `Network error: ${(error as Error)?.message ?? error}`, false, timeout ? "TIMEOUT" : "NETWORK");
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw new ProviderError(`HTTP ${res.status}: ${describe(json) ?? res.statusText}`, permanent, `HTTP_${res.status}`);
  }
  return json;
}
