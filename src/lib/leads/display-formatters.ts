/** Short display ID like #45678 from cuid. */
export function formatLeadDisplayId(id: string) {
  const tail = id.replace(/\D/g, "").slice(-5) || id.slice(-5);
  return `#${tail}`;
}

export function formatLeadListDate(date: Date | string) {
  const d = typeof date === "string" ? new Date(date) : date;
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

export function formatLeadListDateTime(date: Date | string) {
  const d = typeof date === "string" ? new Date(date) : date;
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = String(d.getFullYear()).slice(-2);
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${day}-${month}-${year} ${hours}:${minutes} ${ampm}`;
}

/** Prefer stage name for CRM-style status column. */
export function formatLeadStatusLabel(
  status: string,
  stageName?: string | null,
) {
  if (stageName) return stageName;
  const map: Record<string, string> = {
    NEW: "New",
    OPEN: "Open",
    IN_PROGRESS: "In Progress",
    QUALIFIED: "Qualified",
    CONVERTED: "Confirmed",
    LOST: "Not Interested",
    UNQUALIFIED: "Not Interested",
  };
  return map[status] ?? status.replace(/_/g, " ");
}
