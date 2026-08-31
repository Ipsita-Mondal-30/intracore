"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AcademicSelect({ className }: { className?: string }) {
  return (
    <label className={cn("inline-flex items-center gap-1", className)}>
      <span className="sr-only">Academic program</span>
      <select className="ic-academic-select" defaultValue="academic" aria-label="Academic">
        <option value="academic">ACADEMIC</option>
      </select>
      <ChevronDown className="pointer-events-none -ml-6 h-3.5 w-3.5 text-muted" />
    </label>
  );
}

export function LeadTransferToolbar({
  className,
  onTransfer,
  disabled,
}: {
  className?: string;
  onTransfer?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <label className="inline-flex items-center gap-1">
        <span className="sr-only">Transfer leads to</span>
        <select
          className="ic-academic-select min-w-[160px]"
          defaultValue=""
          aria-label="Lead transfer to"
        >
          <option value="" disabled>
            Lead Transfer To...
          </option>
          <option value="agent">Assign to agent</option>
        </select>
        <ChevronDown className="pointer-events-none -ml-6 h-3.5 w-3.5 text-muted" />
      </label>
      <Button
        type="button"
        size="sm"
        className="rounded-lg px-4"
        disabled={disabled}
        onClick={onTransfer}
      >
        Transfer
      </Button>
    </div>
  );
}

export function ReEngagedPageMeta({
  lastUpdated,
  className,
}: {
  lastUpdated: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-end gap-2 sm:flex-row sm:items-center", className)}>
      <AcademicSelect />
      <p className="text-xs text-muted">Last Update {lastUpdated}</p>
    </div>
  );
}
