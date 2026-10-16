"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";

type Component = { id: string; companyId: string; code: string; name: string; calcType: string };

/** One value per component; filled rows are submitted as JSON in `lines`. */
export function StructureLines({ components }: { components: Component[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const lines = components.filter((c) => values[c.id]).map((c) => ({ componentId: c.id, value: values[c.id] }));
  return (
    <div className="space-y-2 sm:col-span-3">
      <input type="hidden" name="lines" data-json value={JSON.stringify(lines)} />
      {components.map((c) => (
        <label key={c.id} className="grid grid-cols-[1fr_160px] items-center gap-2 text-sm">
          <span>{c.code} · {c.name} <span className="text-2xs text-subtle">{c.calcType === "FIXED" ? "monthly amount" : "percent"}</span></span>
          <Input inputMode="decimal" value={values[c.id] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [c.id]: e.target.value }))} />
        </label>
      ))}
    </div>
  );
}
