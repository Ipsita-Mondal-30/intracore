import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function RecordsTable({
  columns,
  children,
  empty,
  className,
}: {
  columns: { key: string; label: string; className?: string }[];
  children?: ReactNode;
  empty?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead>
          <tr className="bg-[var(--ic-table-header)] text-xs font-semibold uppercase tracking-wide text-muted">
            {columns.map((column) => (
              <th
                key={column.key}
                className={cn(
                  "px-3 py-3 first:rounded-l-xl last:rounded-r-xl",
                  column.className,
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--ic-border)]">
          {children ?? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-3 py-12 text-center text-sm text-muted"
              >
                {empty ?? "No records yet."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function RecordsTableRow({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <tr
      className={cn(
        "bg-white transition hover:bg-[var(--ic-table-row-hover)]",
        onClick ? "cursor-pointer" : null,
        className,
      )}
      onClick={onClick}
    >
      {children}
    </tr>
  );
}

export function RecordsTableCell({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <td className={cn("px-3 py-3.5 align-middle text-sm text-foreground", className)}>
      {children}
    </td>
  );
}
