"use client";

import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="top-right"
      toastOptions={{
        className: "rounded-xl border",
        // inline so it beats Sonner's own light/dark palette and follows our tokens
        style: { background: "var(--ic-surface)", color: "var(--ic-foreground)", borderColor: "var(--ic-border)" },
      }}
    />
  );
}
