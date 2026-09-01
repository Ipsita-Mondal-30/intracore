"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";
import { ModuleRail, AppSidebar } from "@/components/layout/sidebars";
import { AppHeader } from "@/components/layout/app-header";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

export function AppShell({
  userName,
  roleName,
  organizationName,
  leadNavGroups = [],
  organizationId,
  userId,
  notifications,
  unreadNotificationCount,
  browserNotificationsEnabled,
  children,
}: {
  userName: string;
  roleName: string;
  organizationName: string;
  leadNavGroups?: {
    title: string;
    category: string;
    items: { href: string; label: string; slug: string }[];
  }[];
  organizationId?: string;
  userId?: string;
  notifications?: {
    id: string;
    type: string;
    title: string;
    body: string | null;
    data: unknown;
    readAt: string | null;
    createdAt: string;
  }[];
  unreadNotificationCount?: number;
  browserNotificationsEnabled?: boolean;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-canvas p-2 sm:p-3 lg:p-4">
      <ModuleRail />

      <div className="relative hidden md:block">
        <AppSidebar
          userName={userName}
          roleName={roleName}
          organizationName={organizationName}
          leadNavGroups={leadNavGroups}
        />
      </div>

      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/30 transition md:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setMobileOpen(false)}
      />
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-[280px] bg-canvas p-3 transition md:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="mb-2 flex justify-end">
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            onClick={() => setMobileOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <AppSidebar
          userName={userName}
          roleName={roleName}
          organizationName={organizationName}
          leadNavGroups={leadNavGroups}
        />
      </div>

      <main className="ic-panel flex min-w-0 flex-1 flex-col overflow-hidden p-4 sm:p-6 lg:p-7">
        <div className="mb-3 flex items-center gap-2 md:hidden">
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </Button>
          <p className="text-sm font-semibold">{organizationName}</p>
        </div>
        <AppHeader
          placeholder="Search leads, people, settings…"
          organizationId={organizationId}
          userId={userId}
          notifications={notifications}
          unreadNotificationCount={unreadNotificationCount}
          browserNotificationsEnabled={browserNotificationsEnabled}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </main>
      <Toaster />
    </div>
  );
}
