"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Sends the browser's local date-time as an ISO instant (an ApiForm would send it without a timezone). */
export function ScheduleForm({ campaignId, current }: { campaignId: string; current: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  async function save(scheduledAt: string | null) {
    setPending(true);
    try {
      await apiFetch(`/campaigns/${campaignId}/schedule`, { method: "POST", body: { scheduledAt } });
      toast.success(scheduledAt ? "Scheduled" : "Schedule cleared");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not schedule");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} className="max-w-[240px]" aria-label="Send at" />
      <Button type="button" size="sm" disabled={pending || !value} onClick={() => save(new Date(value).toISOString())}>Schedule</Button>
      {current ? <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => save(null)}>Clear schedule</Button> : null}
    </div>
  );
}
