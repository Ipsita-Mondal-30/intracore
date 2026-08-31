"use client";

import { cn } from "@/lib/utils";

export function UnderlineTabs({
  tabs,
  value,
  onChange,
  className,
  activeColor = "primary",
}: {
  tabs: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
  activeColor?: "primary" | "foreground";
}) {
  const activeBorder =
    activeColor === "primary"
      ? "border-[var(--ic-tab-active)] text-foreground"
      : "border-foreground text-foreground";

  return (
    <div
      className={cn(
        "flex flex-wrap gap-x-5 gap-y-1 border-b border-[var(--ic-border)]",
        className,
      )}
      role="tablist"
    >
      {tabs.map((tab) => {
        const active = value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              "-mb-px border-b-2 px-0.5 pb-3 text-sm transition",
              active
                ? cn("font-semibold", activeBorder)
                : "border-transparent text-[var(--ic-tab-inactive)] hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
