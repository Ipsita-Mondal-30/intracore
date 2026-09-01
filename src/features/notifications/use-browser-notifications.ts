"use client";

import { useEffect, useRef } from "react";

export function useBrowserNotifications(enabled: boolean) {
  const permissionRef = useRef<NotificationPermission>(
    typeof window !== "undefined" ? Notification.permission : "default",
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    permissionRef.current = Notification.permission;
  }, []);

  const requestPermission = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return false;
    const result = await Notification.requestPermission();
    permissionRef.current = result;
    return result === "granted";
  };

  const showNotification = (title: string, options?: NotificationOptions) => {
    if (!enabled) return;
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;

    try {
      new Notification(title, options);
    } catch {
      // ignore
    }
  };

  return { requestPermission, showNotification, permission: permissionRef.current };
}
