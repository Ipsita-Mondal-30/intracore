"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";

type Company = { id: string; code: string; branches: { id: string; code: string; name: string }[] };
type Scope = { companyId: string; branchId: string | null };

/** Company / branch access for one member (PUT /api/v1/members/:id/scopes). */
export function ScopeEditor({
  memberId,
  companies,
  initial,
}: {
  memberId: string;
  companies: Company[];
  initial: Scope[];
}) {
  const router = useRouter();
  const [scopes, setScopes] = useState<Scope[]>(initial);
  const [pending, setPending] = useState(false);

  const has = (companyId: string, branchId: string | null) =>
    scopes.some((s) => s.companyId === companyId && s.branchId === branchId);
  const toggle = (companyId: string, branchId: string | null) =>
    setScopes((current) =>
      has(companyId, branchId)
        ? current.filter((s) => !(s.companyId === companyId && s.branchId === branchId))
        : [...current.filter((s) => !(branchId === null && s.companyId === companyId)), { companyId, branchId }],
    );

  async function save() {
    setPending(true);
    try {
      await apiFetch(`/members/${memberId}/scopes`, { method: "PUT", body: { scopes } });
      toast.success("Access updated");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to update access");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-4">
      {companies.map((company) => {
        const all = has(company.id, null);
        return (
          <div key={company.id} className="text-xs">
            <label className="flex items-center gap-1.5 font-semibold">
              <input type="checkbox" checked={all} onChange={() => toggle(company.id, null)} />
              {company.code} (all branches)
            </label>
            {!all
              ? company.branches.map((branch) => (
                  <label key={branch.id} className="ml-4 flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={has(company.id, branch.id)}
                      onChange={() => toggle(company.id, branch.id)}
                    />
                    {branch.code} · {branch.name}
                  </label>
                ))
              : null}
          </div>
        );
      })}
      <Button size="sm" variant="secondary" onClick={save} disabled={pending}>
        {pending ? "Saving…" : "Save access"}
      </Button>
    </div>
  );
}
