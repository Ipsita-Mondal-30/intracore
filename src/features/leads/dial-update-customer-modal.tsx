"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, type FieldPath, type Resolver, type UseFormRegister } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { format } from "date-fns";
import { LeadPriority, LeadStatus } from "@prisma/client";
import { Phone, X } from "lucide-react";
import { toast } from "sonner";
import type { z } from "zod";
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
import {
  RecordsTable,
  RecordsTableCell,
  RecordsTableRow,
} from "@/components/ui/records-table";
import { dialUpdateSchema } from "@/lib/validations/dial-update";
import { dialUpdateCustomerAction } from "@/features/leads/reengaged-actions";
import { createCallRecordAction } from "@/features/leads/call-actions";
import { NoteForm } from "@/features/leads/detail-forms";
import { CALL_OUTCOMES } from "@/lib/leads/call-outcomes";
import { formatShortDateTime } from "@/features/leads/reengaged-format";

type CustomFieldDef = {
  id: string;
  key: string;
  label: string;
  type: string;
  section: string;
  options: unknown;
};

type DialUpdateFormValues = z.infer<typeof dialUpdateSchema>;

function toDateInput(value: string | null | undefined) {
  if (!value) return "";
  return format(new Date(value), "yyyy-MM-dd");
}

function buildDefaultValues(
  lead: DialUpdateLead,
  customFields: CustomFieldDef[],
): DialUpdateFormValues {
  const valueByKey = Object.fromEntries(
    lead.customFieldValues.map((row) => [row.field.key, row.value ?? ""]),
  );
  const customFieldDefaults: Record<string, string> = {};
  for (const field of customFields) {
    customFieldDefaults[field.key] = valueByKey[field.key] ?? "";
  }

  return {
    leadId: lead.id,
    firstName: lead.firstName ?? lead.fullName,
    lastName: lead.lastName ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    alternatePhone: lead.alternatePhone ?? "",
    address: lead.address ?? "",
    stageId: lead.stageId ?? "",
    status: lead.status as LeadStatus,
    priority: lead.priority as LeadPriority,
    nextFollowUpAt: toDateInput(lead.nextFollowUpAt),
    callbackAt: toDateInput(lead.callbackAt),
    comments: "",
    customFields: customFieldDefaults,
  };
}

export type DialUpdateLead = {
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
  callbackAt: string | null;
  customFieldValues: {
    fieldId: string;
    value: string | null;
    field: CustomFieldDef;
  }[];
  notes: {
    id: string;
    content: string;
    createdAt: string;
    author: { name: string | null; email: string };
  }[];
  callRecords: {
    id: string;
    calledAt: string;
    durationSec: number | null;
    phoneNumber: string | null;
    didNumber: string | null;
    outcome: string | null;
    notes: string | null;
    recordingPath: string | null;
    user: { name: string | null; email: string };
  }[];
};

export function DialUpdateCustomerModal({
  open,
  onOpenChange,
  lead,
  stages,
  customFields,
  canEdit = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: DialUpdateLead;
  stages: { id: string; name: string }[];
  customFields: CustomFieldDef[];
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState("preferences");
  const [pending, setPending] = useState(false);

  const defaultValues = useMemo(
    () => buildDefaultValues(lead, customFields),
    [lead, customFields],
  );

  const form = useForm<DialUpdateFormValues>({
    resolver: zodResolver(dialUpdateSchema) as Resolver<DialUpdateFormValues>,
    defaultValues,
    values: open ? defaultValues : undefined,
  });

  const {
    register,
    handleSubmit,
    formState: { isDirty },
    reset,
  } = form;

  function requestClose() {
    if (isDirty) {
      const confirmed = window.confirm(
        "You have unsaved changes. Close without saving?",
      );
      if (!confirmed) return;
    }
    reset(defaultValues);
    onOpenChange(false);
  }

  async function onSubmit(values: DialUpdateFormValues) {
    setPending(true);
    const result = await dialUpdateCustomerAction(values);
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(result.message ?? "Lead updated");
    reset(values);
    onOpenChange(false);
    router.refresh();
  }

  const noteCallRows = useMemo(() => {
    const notes = lead.notes.map((note) => ({
      kind: "note" as const,
      id: note.id,
      at: note.createdAt,
      dialed: "—",
      description: note.content,
      agent: note.author.name ?? note.author.email,
      did: "—",
    }));
    const calls = lead.callRecords.map((call) => ({
      kind: "call" as const,
      id: call.id,
      at: call.calledAt,
      dialed: call.phoneNumber ?? "—",
      description: [call.outcome, call.notes].filter(Boolean).join(" — ") || "Call logged",
      agent: call.user.name ?? call.user.email,
      did: call.didNumber ?? "—",
      recordingPath: call.recordingPath,
    }));
    return [...notes, ...calls].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
  }, [lead.notes, lead.callRecords]);

  const genderField = customFields.find((f) => f.key === "gender");
  const categoryField = customFields.find((f) => f.key === "category");
  const educationFields = customFields.filter(
    (f) => f.key !== "gender" && f.key !== "category",
  );
  const genderOptions =
    genderField && Array.isArray(genderField.options)
      ? (genderField.options as string[])
      : ["Male", "Female"];
  const categoryOptions =
    categoryField && Array.isArray(categoryField.options)
      ? (categoryField.options as string[])
      : ["GEN", "SC/ST", "OBC", "Others"];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
    >
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
            onClick={requestClose}
            className="rounded-full p-1 text-muted hover:bg-[var(--ic-surface-muted)] hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="ic-modal-brand" aria-hidden>
          S
        </div>

        <div className="px-6">
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
              activeColor="primary"
            />
            {lead.phone ? (
              <a href={`tel:${lead.phone}`}>
                <Button type="button" size="sm" className="rounded-lg">
                  <Phone className="h-3.5 w-3.5" />
                  Call
                </Button>
              </a>
            ) : null}
          </div>
        </div>

        {tab === "share" ? (
          <div className="space-y-5 px-6 py-8 text-center">
            <p className="text-sm text-muted">
              Share options will appear here when integrations are enabled.
            </p>
            <Button
              type="button"
              variant="secondary"
              className="min-w-28 rounded-lg border-primary text-primary"
              onClick={requestClose}
            >
              Close
            </Button>
          </div>
        ) : tab === "preferences" ? (
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="space-y-5 px-6 py-5"
          >
            <input type="hidden" {...register("leadId")} />
            <input type="hidden" {...register("status")} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Student Name">
                <Input {...register("firstName")} placeholder="First name" />
              </Field>
              <Field label="Email">
                <Input {...register("email")} type="email" />
              </Field>
              <Field label="Mobile Number 1">
                <Input {...register("phone")} required />
              </Field>
              <Field label="Alternate number">
                <Input {...register("alternatePhone")} />
              </Field>
              <Field label="Address">
                <Input {...register("address")} />
              </Field>
              <Field label="Stage">
                <Select {...register("stageId")}>
                  <option value="">Select stage</option>
                  {stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Follow up">
                <Input type="date" {...register("nextFollowUpAt")} />
              </Field>
              <Field label="Call Back Date">
                <Input type="date" {...register("callbackAt")} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Comments" className="sm:col-span-2">
              <Textarea
                {...register("comments")}
                rows={3}
                placeholder="Add call notes or comments"
              />
            </Field>

            {genderField ? (
              <RadioRow
                legend="Gender"
                name={`customFields.${genderField.key}` as FieldPath<DialUpdateFormValues>}
                register={register}
                defaultValue={defaultValues.customFields?.[genderField.key] ?? genderOptions[0]}
                options={genderOptions.map((value) => ({ value, label: value }))}
              />
            ) : null}

            {categoryField ? (
              <RadioRow
                legend="Category"
                name={`customFields.${categoryField.key}` as FieldPath<DialUpdateFormValues>}
                register={register}
                defaultValue={defaultValues.customFields?.[categoryField.key] ?? categoryOptions[0]}
                options={categoryOptions.map((value) => ({ value, label: value }))}
              />
            ) : null}

            <RadioRow
              legend="Priority"
              name="priority"
              register={register}
              defaultValue={defaultValues.priority}
              options={[
                { value: LeadPriority.HIGH, label: "High" },
                { value: LeadPriority.MEDIUM, label: "Medium" },
                { value: LeadPriority.LOW, label: "Low" },
              ]}
            />

            {educationFields.length > 0 ? (
              <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
                {educationFields.map((field) => (
                  <CustomFieldInput
                    key={field.id}
                    field={field}
                    register={register}
                    defaultValue={defaultValues.customFields?.[field.key] ?? ""}
                  />
                ))}
              </div>
            ) : null}
            </div>

            <div className="flex justify-center gap-3 pb-2 pt-2">
              <Button
                type="submit"
                disabled={pending || !canEdit}
                className="min-w-28 rounded-lg"
              >
                {pending ? "Updating…" : "Update"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="min-w-28 rounded-lg border-primary text-primary"
                onClick={requestClose}
              >
                Close
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-5 px-6 py-5">
            {canEdit ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-sm font-medium">Add note</p>
                  <NoteForm leadId={lead.id} />
                </div>
                <form
                  className="space-y-2"
                  action={async (fd) => {
                    fd.set("leadId", lead.id);
                    const result = await createCallRecordAction(fd);
                    if (!result.ok) toast.error(result.error);
                    else {
                      toast.success("Call recorded");
                      router.refresh();
                    }
                  }}
                >
                  <p className="text-sm font-medium">Log call</p>
                  <input type="hidden" name="leadId" value={lead.id} />
                  <div>
                    <Label htmlFor="modal-call-outcome">Outcome</Label>
                    <Select id="modal-call-outcome" name="outcome" defaultValue="">
                      <option value="">—</option>
                      {CALL_OUTCOMES.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="modal-call-notes">Notes</Label>
                    <Textarea id="modal-call-notes" name="notes" rows={2} />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="modal-call-at">Called at</Label>
                      <Input id="modal-call-at" name="calledAt" type="datetime-local" />
                    </div>
                    <div>
                      <Label htmlFor="modal-call-callback">Callback</Label>
                      <Input id="modal-call-callback" name="callbackAt" type="datetime-local" />
                    </div>
                  </div>
                  <Button size="sm" type="submit">
                    Log call
                  </Button>
                </form>
              </div>
            ) : null}

            <RecordsTable
              columns={[
                { key: "#", label: "#" },
                { key: "date", label: "Date" },
                { key: "dialed", label: "Dialed No" },
                { key: "desc", label: "Description" },
                { key: "agent", label: "Agent Name" },
                { key: "did", label: "DID" },
              ]}
              empty="No notes or call records yet."
            >
              {noteCallRows.map((row, index) => (
                <RecordsTableRow key={`${row.kind}-${row.id}`}>
                  <RecordsTableCell className="text-muted">
                    {index + 1}
                  </RecordsTableCell>
                  <RecordsTableCell>
                    {formatShortDateTime(row.at)}
                  </RecordsTableCell>
                  <RecordsTableCell>{row.dialed}</RecordsTableCell>
                  <RecordsTableCell className="max-w-md">
                    {row.description}
                  </RecordsTableCell>
                  <RecordsTableCell>{row.agent}</RecordsTableCell>
                  <RecordsTableCell>{row.did}</RecordsTableCell>
                </RecordsTableRow>
              ))}
            </RecordsTable>

            <div className="flex justify-center pb-2">
              <Button
                type="button"
                variant="secondary"
                className="min-w-28 rounded-lg border-primary text-primary"
                onClick={requestClose}
              >
                Close
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label className="mb-1.5 text-xs text-muted">{label}</Label>
      {children}
    </div>
  );
}

function RadioRow({
  legend,
  name,
  register,
  defaultValue,
  options,
}: {
  legend: string;
  name: FieldPath<DialUpdateFormValues>;
  register: UseFormRegister<DialUpdateFormValues>;
  defaultValue?: string;
  options: { value: string; label: string }[];
}) {
  return (
    <fieldset className="sm:col-span-2">
      <legend className="mb-2 text-xs font-medium text-muted">{legend}</legend>
      <div className="flex flex-wrap gap-4">
        {options.map((option) => (
          <label
            key={option.value}
            className="inline-flex items-center gap-2 text-sm"
          >
            <input
              type="radio"
              {...register(name)}
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

function CustomFieldInput({
  field,
  register,
  defaultValue,
}: {
  field: CustomFieldDef;
  register: ReturnType<typeof useForm<DialUpdateFormValues>>["register"];
  defaultValue: string;
}) {
  const options = Array.isArray(field.options)
    ? (field.options as string[])
    : null;
  const name = `customFields.${field.key}` as const;

  if (field.type === "TEXTAREA") {
    return (
      <Field label={field.label}>
        <Textarea
          {...register(name)}
          rows={2}
          defaultValue={defaultValue}
          className="sm:col-span-2"
        />
      </Field>
    );
  }

  if (field.type === "SELECT" && options) {
    return (
      <Field label={field.label}>
        <Select {...register(name)} defaultValue={defaultValue}>
          <option value="">—</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  return (
    <Field label={field.label}>
      <Input
        {...register(name)}
        type={
          field.type === "NUMBER"
            ? "number"
            : field.type === "DATE"
              ? "date"
              : "text"
        }
        defaultValue={defaultValue}
      />
    </Field>
  );
}
