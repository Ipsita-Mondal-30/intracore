import { cn } from "@/lib/utils";
import { TrendingDown, TrendingUp } from "lucide-react";

export function KpiCard({
  label,
  value,
  delta,
  deltaTone = "neutral",
  highlighted = false,
  className,
}: {
  label: string;
  value: string | number;
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
  highlighted?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[112px] flex-col justify-between rounded-card border bg-surface p-4 shadow-card",
        highlighted
          ? "border-primary ring-1 ring-primary/20"
          : "border-[var(--ic-border)]",
        className,
      )}
    >
      <div>
        <p className="text-2xl font-bold tracking-tight text-foreground">
          {value}
        </p>
        <p className="mt-1 text-sm text-muted">{label}</p>
      </div>
      {delta ? (
        <p
          className={cn(
            "mt-3 flex items-center gap-1 text-2xs font-medium",
            deltaTone === "up" && "text-success",
            deltaTone === "down" && "text-danger",
            deltaTone === "neutral" && "text-subtle",
          )}
        >
          {deltaTone === "up" ? <TrendingUp className="h-3 w-3" /> : null}
          {deltaTone === "down" ? <TrendingDown className="h-3 w-3" /> : null}
          {delta}
        </p>
      ) : null}
    </div>
  );
}
