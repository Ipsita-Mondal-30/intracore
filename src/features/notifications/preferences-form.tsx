"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { updateNotificationPreferencesAction } from "@/features/notifications/actions";
import { useBrowserNotifications } from "@/features/notifications/use-browser-notifications";

type Prefs = {
  chatMessages: boolean;
  leadAssignments: boolean;
  followUpReminders: boolean;
  taskNotifications: boolean;
  systemNotifications: boolean;
  browserNotifications: boolean;
};

export function NotificationPreferencesForm({ prefs: initial }: { prefs: Prefs }) {
  const [prefs, setPrefs] = useState(initial);
  const [pending, startTransition] = useTransition();
  const { requestPermission } = useBrowserNotifications(true);

  const toggle = (key: keyof Prefs) => {
    setPrefs((p) => ({ ...p, [key]: !p[key] }));
  };

  const save = () => {
    const fd = new FormData();
    for (const [key, value] of Object.entries(prefs)) {
      fd.set(key, value ? "true" : "false");
    }
    startTransition(async () => {
      const result = await updateNotificationPreferencesAction(fd);
      if (result.ok) toast.success("Preferences saved");
      else toast.error(result.error);
    });
  };

  const labels: { key: keyof Prefs; label: string }[] = [
    { key: "chatMessages", label: "Chat messages" },
    { key: "leadAssignments", label: "Lead assignments" },
    { key: "followUpReminders", label: "Follow-up reminders" },
    { key: "taskNotifications", label: "Task notifications" },
    { key: "systemNotifications", label: "System notifications" },
  ];

  return (
    <div className="space-y-4">
      {labels.map(({ key, label }) => (
        <label
          key={key}
          className="flex items-center justify-between rounded-xl border border-[var(--ic-border)] px-4 py-3"
        >
          <span className="text-sm font-medium">{label}</span>
          <input type="checkbox" checked={prefs[key]} onChange={() => toggle(key)} />
        </label>
      ))}

      <div className="rounded-xl border border-[var(--ic-border)] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>Browser notifications</Label>
            <p className="text-sm text-muted">
              Show desktop alerts when you receive new messages.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={async () => {
              const granted = await requestPermission();
              setPrefs((p) => ({ ...p, browserNotifications: granted }));
              if (granted) toast.success("Browser notifications enabled");
              else toast.error("Permission denied");
            }}
          >
            Enable
          </Button>
        </div>
        <p className="mt-2 text-2xs text-subtle">
          Status: {prefs.browserNotifications ? "Enabled" : "Disabled"}
        </p>
      </div>

      <Button type="button" onClick={save} disabled={pending}>
        {pending ? "Saving…" : "Save preferences"}
      </Button>
    </div>
  );
}
