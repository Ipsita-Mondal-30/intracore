"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OrgSettings } from "@/lib/settings";

const DUPLICATE_FIELDS = {
  customer: ["gstin", "email", "phone", "name"],
  lead: ["email", "phone", "whatsapp", "company"],
} as const;

const num = (data: FormData, key: string) => {
  const value = String(data.get(key) ?? "").trim();
  return value === "" ? null : Number(value);
};

/** Organization-wide settings (system.configure): duplicate matching rules and loyalty programme. */
export function OrgSettingsForm({ settings }: { settings: OrgSettings }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    try {
      await apiFetch("/admin/settings/org", {
        method: "PATCH",
        body: {
          duplicates: { customer: data.getAll("customer"), lead: data.getAll("lead") },
          loyalty: {
            enabled: data.get("loyaltyEnabled") === "on",
            pointsPerCurrencyUnit: num(data, "pointsPerCurrencyUnit") ?? 0,
            pointValue: num(data, "pointValue") ?? 0,
            minRedeemPoints: num(data, "minRedeemPoints") ?? 0,
            expiryDays: num(data, "expiryDays"),
          },
        },
      });
      toast.success("Settings saved");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  const l = settings.loyalty;
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {(Object.keys(DUPLICATE_FIELDS) as (keyof typeof DUPLICATE_FIELDS)[]).map((kind) => (
        <fieldset key={kind} className="space-y-2">
          <legend className="mb-1 text-sm font-medium capitalize">{kind} duplicates: match on</legend>
          <div className="flex flex-wrap gap-4">
            {DUPLICATE_FIELDS[kind].map((field) => (
              <label key={field} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={kind} value={field} defaultChecked={(settings.duplicates[kind] as string[]).includes(field)} />
                {field}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Loyalty programme</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="loyaltyEnabled" defaultChecked={l.enabled} /> Enabled
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">Points per currency unit<Input name="pointsPerCurrencyUnit" type="number" step="any" min="0" defaultValue={l.pointsPerCurrencyUnit} /></label>
          <label className="text-sm">Value of one point<Input name="pointValue" type="number" step="any" min="0" defaultValue={l.pointValue} /></label>
          <label className="text-sm">Minimum points to redeem<Input name="minRedeemPoints" type="number" step="1" min="0" defaultValue={l.minRedeemPoints} /></label>
          <label className="text-sm">Points expire after (days, blank = never)<Input name="expiryDays" type="number" step="1" min="1" defaultValue={l.expiryDays ?? ""} /></label>
        </div>
      </fieldset>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save settings"}</Button>
    </form>
  );
}
