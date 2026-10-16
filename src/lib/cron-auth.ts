import { timingSafeEqual } from "crypto";

/** True when the Authorization header is exactly `Bearer $CRON_SECRET`. */
export function isCronAuthorized(header: string | null) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
