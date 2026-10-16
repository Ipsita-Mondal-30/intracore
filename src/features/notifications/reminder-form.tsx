"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/erp/api-form";

/** datetime-local inputs are converted in the browser, so the time means the user's local time. */
const iso = (value: FormDataEntryValue | null) => (value ? new Date(String(value)).toISOString() : undefined);

export function ReminderForm({ members }: { members?: { id: string; label: string }[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    setPending(true);
    try {
      await apiFetch("/reminders", {
        method: "POST",
        body: {
          title: f.get("title"),
          body: f.get("body") || undefined,
          userId: f.get("userId") || undefined,
          nextRunAt: iso(f.get("nextRunAt")),
          recurrence: f.get("recurrence"),
          interval: Number(f.get("interval") || 1),
          endsAt: iso(f.get("endsAt")),
        },
      });
      toast.success("Reminder scheduled");
      form.reset();
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not save the reminder");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      <Field label="Title" className="sm:col-span-2"><Input name="title" required maxLength={200} /></Field>
      <Field label="Note" className="sm:col-span-2"><Textarea name="body" rows={2} maxLength={2000} /></Field>
      <Field label="First reminder"><Input type="datetime-local" name="nextRunAt" required /></Field>
      <Field label="Repeat">
        <Select name="recurrence" defaultValue="NONE">
          <option value="NONE">Does not repeat</option>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
        </Select>
      </Field>
      <Field label="Every" hint="days / weeks / months"><Input type="number" name="interval" min={1} max={365} defaultValue={1} /></Field>
      <Field label="Ends" hint="Optional, for repeating reminders"><Input type="datetime-local" name="endsAt" /></Field>
      {members?.length ? (
        <Field label="For">
          <Select name="userId" defaultValue="">
            <option value="">Me</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
        </Field>
      ) : null}
      <div className="sm:col-span-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Schedule reminder"}</Button>
      </div>
    </form>
  );
}
