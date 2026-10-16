/**
 * Strip credentials from error text before it is stored or logged. Provider SDKs and
 * HTTP errors often echo request headers or URLs that carry tokens.
 */
const PATTERNS: [RegExp, string][] = [
  [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [/((?:access_token|token|api[_-]?key|secret|password|signature|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, "$1[redacted]"],
  [/\bEAA[A-Za-z0-9]{20,}/g, "[redacted]"], // Meta access tokens
  [/\b(?:sk|pk|rk|re)_[A-Za-z0-9_]{16,}/g, "[redacted]"], // common API key shapes
];

export function sanitizeError(error: unknown, max = 500): string {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const [re, sub] of PATTERNS) text = text.replace(re, sub);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
