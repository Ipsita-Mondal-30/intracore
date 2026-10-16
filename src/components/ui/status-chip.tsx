import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  NEW: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  OPEN: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
  IN_PROGRESS: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  RESOLVED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  CLOSED: "bg-neutral-soft text-muted",
  QUALIFIED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  UNQUALIFIED: "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  CONVERTED: "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  LOST: "bg-neutral-soft text-muted",
  Interested: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  Confirmed: "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  "Not-Interested": "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  Potential: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
};

export function leadStatusLabel(status: string) {
  switch (status) {
    case "QUALIFIED":
      return "Interested";
    case "CONVERTED":
      return "Confirmed";
    case "UNQUALIFIED":
      return "Not-Interested";
    case "OPEN":
    case "IN_PROGRESS":
    case "NEW":
      return "Potential";
    case "LOST":
      return "Lost";
    default:
      return status;
  }
}

export function StatusChip({
  status,
  label,
  className,
}: {
  status: string;
  label?: string;
  className?: string;
}) {
  const text = label ?? leadStatusLabel(status);
  const style = STATUS_STYLES[text] ?? STATUS_STYLES[status] ?? "bg-neutral-soft text-neutral-text";
  return (
    <span
      className={cn(
        "inline-flex rounded-md px-2 py-0.5 text-xs font-medium",
        style,
        className,
      )}
    >
      {text}
    </span>
  );
}
