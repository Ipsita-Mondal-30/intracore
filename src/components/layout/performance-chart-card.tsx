"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ranges = ["Week", "Month", "Year"] as const;

/** Visual chart shell matching Figma — empty until analytics APIs exist. */
export function PerformanceChartCard({
  title = "Total Overall Performance",
  emptyMessage = "Performance trends will appear when lead activity is available.",
}: {
  title?: string;
  emptyMessage?: string;
}) {
  const [range, setRange] = useState<(typeof ranges)[number]>("Month");

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <div className="flex rounded-pill bg-[var(--ic-surface-muted)] p-1">
          {ranges.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setRange(item)}
              className={cn(
                "rounded-pill px-3 py-1 text-2xs font-medium transition",
                range === item
                  ? "bg-primary text-white shadow-sm"
                  : "text-muted hover:text-foreground",
              )}
            >
              {item}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative flex h-[220px] items-end justify-between gap-2 rounded-xl bg-[linear-gradient(180deg,#f8faff_0%,#ffffff_100%)] px-2 pb-6 pt-4">
          {/* Grid lines */}
          <div className="pointer-events-none absolute inset-x-4 inset-y-6 flex flex-col justify-between">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="border-t border-dashed border-[var(--ic-border)]"
              />
            ))}
          </div>
          {/* Empty baseline sparkline shape */}
          <svg
            viewBox="0 0 640 160"
            className="absolute inset-x-6 top-8 h-[140px] w-[calc(100%-3rem)] text-primary/25"
            aria-hidden
          >
            <path
              d="M0 120 C80 110, 120 40, 200 70 S320 150, 400 90 S520 20, 640 60"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeDasharray="6 6"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="max-w-sm rounded-xl bg-surface px-4 py-3 text-center text-sm text-muted shadow-sm">
              {emptyMessage}
            </p>
          </div>
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
            <span
              key={day}
              className="relative z-10 flex-1 text-center text-2xs text-subtle"
            >
              {day}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
