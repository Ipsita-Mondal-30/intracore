"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Module = { module: string; permissions: { code: string; name: string }[] };

/** Create (no role) or edit a custom role: name, description and catalog permissions by module. */
export function RoleEditor({
  modules,
  role,
}: {
  modules: Module[];
  role?: { id: string; code: string; name: string; description: string | null; permissions: string[] };
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = {
      ...(role ? {} : { code: String(data.get("code") ?? "") }),
      name: String(data.get("name") ?? ""),
      description: String(data.get("description") ?? "") || null,
      permissions: data.getAll("permissions").map(String),
    };
    setPending(true);
    try {
      await apiFetch(role ? `/admin/roles/${role.id}` : "/admin/roles", { method: role ? "PATCH" : "POST", body });
      toast.success(role ? "Role saved" : "Role created");
      if (!role) form.reset();
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  const granted = new Set(role?.permissions ?? []);
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {role ? null : <label className="text-sm">Code<Input name="code" required placeholder="field_supervisor" /></label>}
        <label className="text-sm">Name<Input name="name" required defaultValue={role?.name} /></label>
        <label className="text-sm">Description<Input name="description" defaultValue={role?.description ?? ""} /></label>
      </div>
      <div className="grid max-h-96 gap-3 overflow-auto rounded-xl border border-[var(--ic-border)] p-3 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map((m) => (
          <fieldset key={m.module} className="text-xs">
            <legend className="mb-1 font-semibold uppercase tracking-wide text-subtle">{m.module}</legend>
            {m.permissions.map((p) => (
              <label key={p.code} className="flex items-center gap-1.5">
                <input type="checkbox" name="permissions" value={p.code} defaultChecked={granted.has(p.code)} />
                {p.code.split(".")[1]}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : role ? "Save role" : "Create role"}</Button>
    </form>
  );
}
