/** Display helpers. Amounts arrive as Decimal/strings; formatting for display only. */
export function formatMoney(value: { toString(): string } | string | number | null | undefined, currency = "INR") {
  if (value === null || value === undefined) return "—";
  const n = Number(value.toString());
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

export function formatQty(value: { toString(): string } | string | number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 4 }).format(Number(value.toString()));
}

export function formatDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

export function formatDateTime(value: Date | string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

/** yyyy-mm-dd for <input type="date">. */
export function dateInput(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

export const humanize = (value: string) => value.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
