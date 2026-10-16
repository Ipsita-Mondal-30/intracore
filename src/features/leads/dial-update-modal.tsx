"use client";

import { useActionState, useEffect, useState } from "react";
import { Phone, X } from "lucide-react";
import { toast } from "sonner";
import { LeadPriority, LeadStatus } from "@prisma/client";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import type { ActionResult } from "@/features/auth/types";
import { updateReEngagedLeadAction } from "@/features/leads/reengaged-actions";

type StageOption = { id: string; name: string };

export function DialUpdateModal({
  open,
  onOpenChange,
  lead,
  stages,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    fullName: string;
    email: string | null;
    phone: string | null;
    alternatePhone: string | null;
    address: string | null;
    stageId: string | null;
    status: string;
    priority: string;
    nextFollowUpAt: string | null;
    description: string | null;
  };
  stages: StageOption[];
}) {
  const [tab, setTab] = useState("preferences");
  const [state, formAction, pending] = useActionState(
    updateReEngagedLeadAction,
    null as ActionResult | null,
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message ?? "Updated");
      onOpenChange(false);
    } else if (state && !state.ok) {
      toast.error(state.error);
    }
  }, [state, onOpenChange]);

  const followUpValue = lead.nextFollowUpAt
    ? new Date(lead.nextFollowUpAt).toISOString().slice(0, 10)
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] w-[min(920px,calc(100%-1.5rem))] overflow-y-auto rounded-2xl p-0"
        showClose={false}
      >
        <div className="flex items-center justify-between border-b border-[var(--ic-border)] px-6 py-4">
          <DialogTitle className="text-lg font-semibold">
            Dial &amp; Update Customer Info
          </DialogTitle>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-full p-1 text-muted hover:bg-[var(--ic-surface-muted)] hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 pt-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <UnderlineTabs
              tabs={[
                { id: "preferences", label: "Preferences" },
                { id: "notes", label: "Notes & Call Records" },
                { id: "share", label: "Share" },
              ]}
              value={tab}
              onChange={setTab}
              className="flex-1"
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="rounded-lg bg-primary hover:bg-primary-hover"
                onClick={() => {
                  if (lead.phone) window.location.href = `tel:${lead.phone}`;
                }}
              >
                <Phone className="h-3.5 w-3.5" />
                Call
              </Button>
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                S
              </span>
            </div>
          </div>
        </div>

        {tab === "preferences" ? (
          <form action={formAction} className="space-y-5 px-6 py-5">
            <input type="hidden" name="leadId" value={lead.id} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Student Name">
                <Input
                  name="firstName"
                  defaultValue={lead.firstName ?? lead.fullName}
                  placeholder="First name"
                />
              </Field>
              <Field label="Email">
                <Input
                  name="email"
                  type="email"
                  defaultValue={lead.email ?? ""}
                />
              </Field>
              <Field label="Mobile Number 1">
                <Input name="phone" defaultValue={lead.phone ?? ""} required />
              </Field>
              <Field label="Alternate number">
                <Input
                  name="alternatePhone"
                  defaultValue={lead.alternatePhone ?? ""}
                />
              </Field>
              <Field label="Address">
                <Input name="address" defaultValue={lead.address ?? ""} />
              </Field>
              <Field label="Stage">
                <Select name="stageId" defaultValue={lead.stageId ?? ""}>
                  <option value="">Select stage</option>
                  {stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Follow up">
                <Input
                  type="date"
                  name="nextFollowUpAt"
                  defaultValue={followUpValue}
                />
              </Field>
              <Field label="Call Back Date">
                <Input type="date" name="callbackDate" defaultValue={followUpValue} />
              </Field>
            </div>

            <Field label="Comments">
              <Textarea
                name="comments"
                rows={3}
                placeholder="Add call notes or comments"
                defaultValue=""
              />
            </Field>

            <input type="hidden" name="lastName" value={lead.lastName ?? ""} />
            <input type="hidden" name="description" value={lead.description ?? ""} />

            <RadioRow
              legend="Priority"
              name="priority"
              defaultValue={lead.priority}
              options={[
                { value: LeadPriority.HIGH, label: "High" },
                { value: LeadPriority.MEDIUM, label: "Medium" },
                { value: LeadPriority.LOW, label: "Low" },
              ]}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <fieldset>
                <legend className="mb-2 text-xs font-medium text-muted">
                  Gender
                </legend>
                <div className="flex flex-wrap gap-4">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="gender"
                      value="male"
                      defaultChecked
                      className="accent-[var(--ic-primary)]"
                    />
                    Male
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="gender"
                      value="female"
                      className="accent-[var(--ic-primary)]"
                    />
                    Female
                  </label>
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-2 text-xs font-medium text-muted">
                  Category
                </legend>
                <div className="flex flex-wrap gap-4">
                  {["GEN", "SC/ST", "OBC", "Others"].map((cat, i) => (
                    <label
                      key={cat}
                      className="inline-flex items-center gap-2 text-sm"
                    >
                      <input
                        type="radio"
                        name="category"
                        value={cat}
                        defaultChecked={i === 0}
                        className="accent-[var(--ic-primary)]"
                      />
                      {cat}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <RadioRow
              legend="Status"
              name="status"
              defaultValue={lead.status}
              options={[
                { value: LeadStatus.QUALIFIED, label: "Interested" },
                { value: LeadStatus.CONVERTED, label: "Confirmed" },
                { value: LeadStatus.UNQUALIFIED, label: "Not-Interested" },
                { value: LeadStatus.OPEN, label: "Potential" },
              ]}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Location">
                <Select name="location" defaultValue="">
                  <option value="">Interested Location</option>
                </Select>
              </Field>
              <Field label="School Name">
                <Select name="school" defaultValue="">
                  <option value="">Interested School</option>
                </Select>
              </Field>
              <Field label="Stream">
                <Select name="stream" defaultValue="">
                  <option value="">Interested Stream</option>
                </Select>
              </Field>
              <Field label="Course">
                <Select name="course" defaultValue="">
                  <option value="">Interested Course</option>
                </Select>
              </Field>
              <Field label="Last Institute">
                <Input name="lastInstitute" placeholder="Last Institute" />
              </Field>
              <Field label="CGP">
                <Input name="cgp" placeholder="CGP" />
              </Field>
              <Field label="Last STD">
                <Input name="lastStd" placeholder="Last STD" />
              </Field>
              <Field label="Discount in fees">
                <Select name="discount" defaultValue="10">
                  <option value="10">10%</option>
                  <option value="15">15%</option>
                  <option value="20">20%</option>
                </Select>
              </Field>
            </div>

            <div className="flex justify-center gap-3 pb-2 pt-2">
              <Button
                type="submit"
                disabled={pending}
                className="min-w-28 rounded-lg bg-primary hover:bg-primary-hover"
              >
                {pending ? "Updating…" : "Update"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="min-w-28 rounded-lg border-primary text-primary"
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
            </div>
          </form>
        ) : (
          <div className="px-6 py-10 text-center text-sm text-muted">
            {tab === "notes"
              ? "Switch to the lead overview for Notes & Call Records."
              : "Share options coming soon."}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="mb-1.5 text-xs text-muted">{label}</Label>
      {children}
    </div>
  );
}

function RadioRow({
  legend,
  name,
  defaultValue,
  options,
}: {
  legend: string;
  name: string;
  defaultValue: string;
  options: { value: string; label: string }[];
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium text-muted">{legend}</legend>
      <div className="flex flex-wrap gap-4">
        {options.map((option) => (
          <label
            key={option.value}
            className="inline-flex items-center gap-2 text-sm"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              defaultChecked={defaultValue === option.value}
              className="accent-[var(--ic-primary)]"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
