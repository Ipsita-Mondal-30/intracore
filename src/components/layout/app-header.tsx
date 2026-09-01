"use client";

import Link from "next/link";
import { LayoutGrid, MessageSquare, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NotificationCenter, type NotificationItem } from "@/features/notifications/notification-center";

export function AppHeader({
  placeholder = "Search…",
  organizationId,
  userId,
  notifications,
  unreadNotificationCount,
  browserNotificationsEnabled,
}: {
  placeholder?: string;
  organizationId?: string;
  userId?: string;
  notifications?: NotificationItem[];
  unreadNotificationCount?: number;
  browserNotificationsEnabled?: boolean;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative w-full max-w-xl flex-1">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <Input
          className="h-11 rounded-pill border-[var(--ic-border)] bg-[var(--ic-surface-muted)] pl-10"
          placeholder={placeholder}
          aria-label="Search"
        />
      </div>

      <div className="flex items-center gap-2 self-end sm:self-auto">
        <Button
          type="button"
          size="icon-sm"
          className="rounded-full"
          aria-label="Create"
        >
          <Plus className="h-4 w-4" />
        </Button>
        {organizationId && userId ? (
          <NotificationCenter
            organizationId={organizationId}
            userId={userId}
            initialNotifications={notifications}
            initialUnreadCount={unreadNotificationCount}
            browserNotificationsEnabled={browserNotificationsEnabled}
          />
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label="Notifications"
          >
            <span className="sr-only">Notifications</span>
          </Button>
        )}
        <Link href="/messages">
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label="Messages"
          >
            <MessageSquare className="h-4 w-4" />
          </Button>
        </Link>
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          aria-label="Apps"
        >
          <LayoutGrid className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
