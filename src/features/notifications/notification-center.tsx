"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Bell, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/features/notifications/actions";
import { useNotificationsRealtime } from "@/features/chat/hooks/use-notifications-realtime";
import { useBrowserNotifications } from "@/features/notifications/use-browser-notifications";

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: unknown;
  readAt: string | null;
  createdAt: string;
};

export function NotificationCenter({
  organizationId,
  userId,
  initialNotifications,
  initialUnreadCount,
  browserNotificationsEnabled: initialBrowserNotificationsEnabled,
}: {
  organizationId: string;
  userId: string;
  initialNotifications?: NotificationItem[];
  initialUnreadCount?: number;
  browserNotificationsEnabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState(initialNotifications ?? []);
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(
    initialBrowserNotificationsEnabled ?? false,
  );
  const [loaded, setLoaded] = useState(
    initialNotifications !== undefined && initialUnreadCount !== undefined,
  );
  const [serverUnreadCount, setServerUnreadCount] = useState(initialUnreadCount ?? 0);

  useEffect(() => {
    if (loaded) return;

    let cancelled = false;
    void fetch("/api/notifications")
      .then((res) => res.json())
      .then((data: {
        ok?: boolean;
        notifications?: NotificationItem[];
        unreadNotificationCount?: number;
        browserNotificationsEnabled?: boolean;
      }) => {
        if (cancelled || !data.ok) return;
        setNotifications(data.notifications ?? []);
        setServerUnreadCount(data.unreadNotificationCount ?? 0);
        setBrowserNotificationsEnabled(data.browserNotificationsEnabled ?? false);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [loaded]);

  const { showNotification } = useBrowserNotifications(browserNotificationsEnabled);

  const { unreadCount, setUnreadCount } = useNotificationsRealtime(
    organizationId,
    userId,
    serverUnreadCount,
    (n) => {
      setNotifications((prev) => [n, ...prev].slice(0, 30));
      showNotification(n.title, { body: n.body ?? undefined });
    },
  );

  const openNotification = async (n: NotificationItem) => {
    if (!n.readAt) {
      await markNotificationReadAction(n.id);
      setUnreadCount((c) => Math.max(0, c - 1));
      setNotifications((prev) =>
        prev.map((item) =>
          item.id === n.id ? { ...item, readAt: new Date().toISOString() } : item,
        ),
      );
    }

    const data =
      n.data && typeof n.data === "object" ? (n.data as Record<string, string>) : {};
    if (data.href) {
      router.push(data.href);
    } else if (data.conversationId) {
      router.push(`/messages/${data.conversationId}`);
    }
    setOpen(false);
  };

  const markAllRead = async () => {
    const result = await markAllNotificationsReadAction();
    if (result.ok) {
      setUnreadCount(0);
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })),
      );
      toast.success("All notifications marked read");
    }
  };

  return (
    <div className="relative">
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
        className="relative"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </Button>

      {open ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40"
            aria-label="Close notifications"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-50 mt-2 w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-[var(--ic-border)] bg-white shadow-card">
            <div className="flex items-center justify-between border-b border-[var(--ic-border)] px-4 py-3">
              <p className="font-semibold">Notifications</p>
              <Button type="button" variant="secondary" size="sm" onClick={markAllRead}>
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </Button>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="p-4 text-sm text-muted">No notifications yet.</p>
              ) : (
                notifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => openNotification(n)}
                    className={`flex w-full flex-col gap-1 border-b border-[var(--ic-border)] px-4 py-3 text-left hover:bg-[var(--ic-surface-muted)] ${
                      !n.readAt ? "bg-primary-soft/40" : ""
                    }`}
                  >
                    <p className="text-sm font-medium">{n.title}</p>
                    {n.body ? <p className="text-sm text-muted">{n.body}</p> : null}
                    <p className="text-2xs text-subtle">
                      {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                    </p>
                  </button>
                ))
              )}
            </div>
            <div className="border-t border-[var(--ic-border)] px-4 py-2">
              <Link
                href="/settings/notifications"
                className="text-xs text-primary hover:underline"
                onClick={() => setOpen(false)}
              >
                Notification settings
              </Link>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
