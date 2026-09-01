"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Phone } from "lucide-react";
import { toast } from "sonner";
import { updateLeadAction } from "@/features/leads/actions";
import { createCallRecordAction } from "@/features/leads/call-actions";
import { saveLeadCustomFieldsAction } from "@/features/leads/custom-field-actions";
import { formatLeadDisplayId } from "@/lib/leads/display-formatters";
import { CALL_OUTCOMES } from "@/lib/leads/call-outcomes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LeadPriority } from "@prisma/client";

type CustomFieldDef = {
  id: string;
  key: string;
  label: string;
  type: string;
  section: string;
  options: unknown;
};

type LeadDialLead = {
  id: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  alternatePhone: string | null;
  whatsappNumber: string | null;
  address: string | null;
  sourceId: string | null;
  stageId: string | null;
  pipelineId: string | null;
  priority: string;
  callbackAt: string | null;
  nextFollowUpAt: string | null;
  description: string | null;
  customFieldValues: {
    fieldId: string;
    value: string | null;
    field: CustomFieldDef;
  }[];
};

function toDatetimeLocal(value: string | null) {
  if (!value) return "";
  return format(new Date(value), "yyyy-MM-dd'T'HH:mm");
}

function toFormData(lead: LeadDialLead, form: HTMLFormElement) {
  const fd = new FormData(form);
  fd.set("leadId", lead.id);
  fd.set("firstName", lead.firstName ?? lead.fullName.split(" ")[0] ?? "Lead");
  const lastName = lead.lastName ?? lead.fullName.split(" ").slice(1).join(" ");
  if (lastName) fd.set("lastName", lastName);
  if (lead.sourceId) fd.set("sourceId", lead.sourceId);
  if (lead.pipelineId) fd.set("pipelineId", lead.pipelineId);
  return fd;
}

function RadioGroup({
  name,
  options,
  defaultValue,
}: {
  name: string;
  options: string[];
  defaultValue?: string;
}) {
  return (
    <div className="flex flex-wrap gap-4">
      {options.map((opt) => (
        <label key={opt} className="inline-flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={name}
            value={opt}
            defaultChecked={defaultValue === opt}
            className="h-4 w-4 accent-primary"
          />
          {opt}
        </label>
      ))}
    </div>
  );
}

export function LeadDialUpdateDialog({
  lead,
  stages,
  customFields,
  open,
  onOpenChange,
}: {
  lead: LeadDialLead;
  stages: { id: string; name: string }[];
  customFields: CustomFieldDef[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState("preferences");
  const tel = lead.phone ? `tel:${lead.phone}` : null;

  const valueByKey = Object.fromEntries(
    lead.customFieldValues.map((row) => [row.field.key, row.value ?? ""]),
  );

  const preferenceFields = customFields.filter((f) => f.section === "preferences");
  const otherFields = customFields.filter((f) => f.section !== "preferences");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const form = e.currentTarget;
    const fd = toFormData(lead, form);

    const result = await updateLeadAction(null, fd);
    if (!result.ok) {
      setPending(false);
      toast.error(result.error);
      return;
    }

    const customValues: Record<string, string> = {};
    for (const field of customFields) {
      const input = form.elements.namedItem(`cf_${field.key}`);
      if (
        input instanceof HTMLInputElement ||
        input instanceof HTMLTextAreaElement ||
        input instanceof HTMLSelectElement
      ) {
        customValues[field.key] = input.value;
      }
    }
    await saveLeadCustomFieldsAction(lead.id, customValues);

    if (tab === "notes") {
      const callFd = new FormData(form);
      callFd.set("leadId", lead.id);
      if (!callFd.get("outcome") && !callFd.get("notes") && !callFd.get("recording")) {
        // skip empty call log
      } else {
        const callResult = await createCallRecordAction(callFd);
        if (!callResult.ok) {
          setPending(false);
          toast.error(callResult.error);
          return;
        }
      }
    }

    setPending(false);
    toast.success("Lead updated");
    onOpenChange(false);
    router.refresh();
  }

  function renderCustomField(field: CustomFieldDef) {
    const options = Array.isArray(field.options) ? (field.options as string[]) : null;
    const defaultValue = valueByKey[field.key] ?? "";

    if (field.type === "TEXTAREA") {
      return (
        <Textarea
          id={`cf-${field.key}`}
          name={`cf_${field.key}`}
          rows={2}
          defaultValue={defaultValue}
        />
      );
    }
    if (field.type === "SELECT" && options) {
      return (
        <Select id={`cf-${field.key}`} name={`cf_${field.key}`} defaultValue={defaultValue}>
          <option value="">—</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      );
    }
    return (
      <Input
        id={`cf-${field.key}`}
        name={`cf_${field.key}`}
        type={field.type === "NUMBER" ? "number" : field.type === "DATE" ? "date" : "text"}
        defaultValue={defaultValue}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(92vh,820px)] max-w-3xl overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <DialogTitle>Dial &amp; Update Customer Info</DialogTitle>
            <DialogDescription>
              Update Lead {formatLeadDisplayId(lead.id)}
            </DialogDescription>
          </div>
          {tel ? (
            <a href={tel}>
              <Button size="sm" type="button">
                <Phone className="h-3.5 w-3.5" />
                Call
              </Button>
            </a>
          ) : null}
        </div>

        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "preferences", label: "Preferences" },
            { id: "notes", label: "Notes & Call Records" },
            { id: "share", label: "Share" },
          ]}
        />

        <form onSubmit={handleSubmit} className="mt-4 space-y-5">
          {tab === "preferences" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="dial-first">Student Name</Label>
                  <Input
                    id="dial-first"
                    name="firstName"
                    defaultValue={lead.firstName ?? lead.fullName.split(" ")[0] ?? ""}
                    placeholder="First name"
                  />
                </div>
                <div>
                  <Label htmlFor="dial-last" className="invisible sm:visible">
                    Last name
                  </Label>
                  <Input
                    id="dial-last"
                    name="lastName"
                    defaultValue={lead.lastName ?? lead.fullName.split(" ").slice(1).join(" ")}
                    placeholder="Last name"
                  />
                </div>
                <div>
                  <Label htmlFor="dial-email">Email</Label>
                  <Input id="dial-email" name="email" type="email" defaultValue={lead.email ?? ""} />
                </div>
                <div>
                  <Label htmlFor="dial-phone">Mobile Number 1</Label>
                  <div className="flex gap-2">
                    <Input id="dial-phone" name="phone" defaultValue={lead.phone ?? ""} className="flex-1" />
                    {tel ? (
                      <a href={tel}>
                        <Button type="button" size="icon-sm" variant="secondary">
                          <Phone className="h-3.5 w-3.5" />
                        </Button>
                      </a>
                    ) : null}
                  </div>
                </div>
                <div>
                  <Label htmlFor="dial-alt">Alternate number</Label>
                  <Input id="dial-alt" name="alternatePhone" defaultValue={lead.alternatePhone ?? ""} />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="dial-address">Address</Label>
                  <Input id="dial-address" name="address" defaultValue={lead.address ?? ""} />
                </div>
                <div>
                  <Label htmlFor="dial-stage">Stage</Label>
                  <Select id="dial-stage" name="stageId" defaultValue={lead.stageId ?? ""}>
                    <option value="">Select stage</option>
                    {stages.map((stage) => (
                      <option key={stage.id} value={stage.id}>
                        {stage.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="dial-priority">Priority</Label>
                  <Select id="dial-priority" name="priority" defaultValue={lead.priority}>
                    {(["LOW", "MEDIUM", "HIGH", "URGENT"] as LeadPriority[]).map((p) => (
                      <option key={p} value={p}>
                        {p.charAt(0) + p.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="dial-follow-up">Follow up</Label>
                  <Input
                    id="dial-follow-up"
                    name="nextFollowUpAt"
                    type="datetime-local"
                    defaultValue={toDatetimeLocal(lead.nextFollowUpAt)}
                  />
                </div>
                <div>
                  <Label htmlFor="dial-callback">Call Back Date</Label>
                  <Input
                    id="dial-callback"
                    name="callbackAt"
                    type="datetime-local"
                    defaultValue={toDatetimeLocal(lead.callbackAt)}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="dial-comments">Comments</Label>
                  <Textarea
                    id="dial-comments"
                    name="description"
                    rows={3}
                    defaultValue={lead.description ?? ""}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <Label>Gender</Label>
                  <RadioGroup
                    name="cf_gender"
                    options={["Male", "Female"]}
                    defaultValue={valueByKey.gender || "Male"}
                  />
                </div>
                <div>
                  <Label>Category</Label>
                  <RadioGroup
                    name="cf_category"
                    options={["GEN", "SC/ST", "OBC", "Others"]}
                    defaultValue={valueByKey.category || "GEN"}
                  />
                </div>
                <div>
                  <Label>Priority</Label>
                  <RadioGroup
                    name="cf_priority_level"
                    options={["High", "Medium", "Low"]}
                    defaultValue={valueByKey.priority_level || "High"}
                  />
                </div>
              </div>

              {(preferenceFields.length > 0 || otherFields.length > 0) ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {[...preferenceFields, ...otherFields].map((field) => (
                    <div key={field.id} className={field.type === "TEXTAREA" ? "sm:col-span-2" : undefined}>
                      <Label htmlFor={`cf-${field.key}`}>{field.label}</Label>
                      {renderCustomField(field)}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    ["location", "Location", "Interested Location"],
                    ["school_name", "School Name", "Interested School"],
                    ["stream", "Stream", "Interested Stream"],
                    ["course", "Course", "Interested Course"],
                    ["last_institute", "Last Institute", ""],
                    ["cgpa", "CGP", ""],
                    ["last_std", "Last STD", ""],
                    ["discount_type", "Discount Type", "10%"],
                  ].map(([key, label, placeholder]) => (
                    <div key={key}>
                      <Label htmlFor={`cf-${key}`}>{label}</Label>
                      <Input
                        id={`cf-${key}`}
                        name={`cf_${key}`}
                        placeholder={placeholder}
                        defaultValue={valueByKey[key] ?? (key === "discount_type" ? "10%" : "")}
                      />
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}

          {tab === "notes" ? (
            <div className="space-y-3">
              <div>
                <Label htmlFor="call-outcome">Call outcome</Label>
                <Select id="call-outcome" name="outcome" defaultValue="">
                  <option value="">—</option>
                  {CALL_OUTCOMES.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="call-notes">Notes / Reason</Label>
                <Textarea id="call-notes" name="notes" rows={3} placeholder="Reason: Not looking for any school" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="call-phone">Dialed No</Label>
                  <Input id="call-phone" name="phoneNumber" defaultValue={lead.phone ?? ""} />
                </div>
                <div>
                  <Label htmlFor="call-did">DID</Label>
                  <Input id="call-did" name="did" placeholder="Direct line" />
                </div>
              </div>
              <div>
                <Label htmlFor="call-recording">Call recording</Label>
                <Input id="call-recording" name="recording" type="file" accept="audio/*" />
                <p className="mt-1 text-2xs text-subtle">Upload MP3, WAV, or WebM (max 25MB)</p>
              </div>
            </div>
          ) : null}

          {tab === "share" ? (
            <p className="text-sm text-muted">
              Share this lead with teammates from the lead detail page using Transfer, or copy the
              link: <span className="font-medium text-primary">/leads/{lead.id}</span>
            </p>
          ) : null}

          <div className="flex justify-center gap-3 border-t border-[var(--ic-border)] pt-4">
            <Button type="submit" disabled={pending} className="min-w-28">
              {pending ? "Updating…" : "Update"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
