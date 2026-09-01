"use client";

import {
  FileText,
  Mail,
  MessageSquare,
  Phone,
  RefreshCw,
  Share2,
  UserPlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ActionId =
  | "update"
  | "notes"
  | "share"
  | "email"
  | "sms"
  | "eoi"
  | "referral"
  | "contacts"
  | "do-not-call"
  | "close";

const ACTIONS: {
  id: ActionId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
}[] = [
  { id: "update", label: "Update", icon: RefreshCw },
  { id: "notes", label: "Notes", icon: FileText },
  { id: "share", label: "Share", icon: Share2 },
  { id: "email", label: "Email", icon: Mail },
  { id: "sms", label: "SMS", icon: MessageSquare },
  { id: "eoi", label: "EOI", icon: FileText },
  { id: "referral", label: "Referral", icon: UserPlus },
  { id: "contacts", label: "Contacts", icon: UserPlus },
  { id: "do-not-call", label: "Do not Call", icon: Phone, disabled: true },
  { id: "close", label: "Close", icon: X },
];

export function LeadActionToolbar({
  active = "update",
  onAction,
}: {
  active?: ActionId;
  onAction: (action: ActionId) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-[var(--ic-border)] pb-4">
      {ACTIONS.map(({ id, label, icon: Icon, disabled }) => (
        <Button
          key={id}
          type="button"
          size="sm"
          variant={active === id ? "default" : "secondary"}
          disabled={disabled}
          className={cn("rounded-full px-4", active === id && "shadow-sm")}
          onClick={() => onAction(id)}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </Button>
      ))}
    </div>
  );
}
