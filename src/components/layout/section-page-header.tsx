import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

export function PrivateAccessBadge({ className }: { className?: string }) {
  return (
    <span className={cn("ic-private-badge", className)}>
      <Lock className="h-3 w-3" />
      Private Access
    </span>
  );
}

export function SectionPageHeader({
  title,
  subtitle,
  badge,
  meta,
  actions,
  className,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {subtitle ? (
          <p className="ic-page-subtitle">{subtitle}</p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="ic-page-title">{title}</h1>
          {badge}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {actions}
        {meta ? (
          <p className="text-xs text-muted">{meta}</p>
        ) : null}
      </div>
    </div>
  );
}
