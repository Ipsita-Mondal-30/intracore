import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { requirePermission } from "@/lib/tenant";
import { getInquiryById, getInquiryLookups } from "@/features/inquiries/queries";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusChip } from "@/components/ui/status-chip";
import { InquiryForm } from "@/features/inquiries/inquiry-form";

function inquiryStatusLabel(status: string) {
  return status
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

export default async function InquiryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const tenant = await requirePermission("lead.view");
  const { id } = await params;
  const inquiry = await getInquiryById(tenant, id);

  if (!inquiry) {
    notFound();
  }

  const lookups = await getInquiryLookups(tenant.organizationId);

  return (
    <div>
      <PageHeader
        breadcrumbs={["Leads", "Inquiries", inquiry.subject]}
        title={inquiry.subject}
        subtitle={`Created ${format(inquiry.createdAt, "dd MMM yyyy HH:mm")}`}
        actions={
          <Link
            href="/leads/inquiries"
            className="inline-flex h-8 items-center justify-center rounded-lg border border-[var(--ic-border)] bg-surface px-3 text-xs font-medium hover:bg-[var(--ic-surface-muted)]"
          >
            Back to list
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="ic-card p-4">
          <p className="text-2xs font-semibold uppercase tracking-wider text-subtle">
            Status
          </p>
          <div className="mt-2">
            <StatusChip
              status={inquiry.status}
              label={inquiryStatusLabel(inquiry.status)}
            />
          </div>
        </div>
        <div className="ic-card p-4">
          <p className="text-2xs font-semibold uppercase tracking-wider text-subtle">
            Contact
          </p>
          <p className="mt-2 text-sm font-medium">{inquiry.contactName}</p>
          {inquiry.email ? (
            <p className="text-2xs text-muted">{inquiry.email}</p>
          ) : null}
          {inquiry.phone ? (
            <p className="text-2xs text-muted">{inquiry.phone}</p>
          ) : null}
        </div>
        <div className="ic-card p-4">
          <p className="text-2xs font-semibold uppercase tracking-wider text-subtle">
            Assigned
          </p>
          <p className="mt-2 text-sm font-medium">
            {inquiry.assignedUser?.name ??
              inquiry.assignedUser?.email ??
              "Unassigned"}
          </p>
        </div>
        <div className="ic-card p-4">
          <p className="text-2xs font-semibold uppercase tracking-wider text-subtle">
            Linked lead
          </p>
          <p className="mt-2 text-sm font-medium">
            {inquiry.linkedLead ? (
              <Link href={`/leads/${inquiry.linkedLead.id}`} className="text-primary">
                {inquiry.linkedLead.fullName}
              </Link>
            ) : (
              "None"
            )}
          </p>
        </div>
      </div>

      {inquiry.description ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Description</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-muted">{inquiry.description}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Edit inquiry</CardTitle>
        </CardHeader>
        <CardContent>
          <InquiryForm lookups={lookups} inquiry={inquiry} />
        </CardContent>
      </Card>
    </div>
  );
}
