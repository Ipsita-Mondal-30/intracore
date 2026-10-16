import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { orgSettings } from "@/lib/settings";

export type DuplicateMatch = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  matchedOn: string[];
};

export async function findDuplicateLeads(
  organizationId: string,
  input: {
    email?: string | null;
    phone?: string | null;
    whatsappNumber?: string | null;
    company?: string | null;
  },
  excludeLeadId?: string,
): Promise<DuplicateMatch[]> {
  // Which fields count as a match is configurable per organization (CRM settings).
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });
  const rules = new Set<string>(orgSettings(org?.settings).duplicates.lead);
  input = {
    email: rules.has("email") ? input.email : null,
    phone: rules.has("phone") ? input.phone : null,
    whatsappNumber: rules.has("whatsapp") ? input.whatsappNumber : null,
    company: rules.has("company") ? input.company : null,
  };

  const or: Prisma.LeadWhereInput[] = [];
  if (input.email) or.push({ email: { equals: input.email, mode: "insensitive" } });
  if (input.phone) or.push({ phone: input.phone });
  if (input.whatsappNumber) or.push({ whatsappNumber: input.whatsappNumber });
  if (input.company) {
    or.push({ company: { equals: input.company, mode: "insensitive" } });
  }
  if (or.length === 0) return [];

  const rows = await prisma.lead.findMany({
    where: {
      organizationId,
      archivedAt: null,
      ...(excludeLeadId ? { id: { not: excludeLeadId } } : {}),
      OR: or,
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      whatsappNumber: true,
      company: true,
    },
    take: 10,
  });

  return rows.map((row) => {
    const matchedOn: string[] = [];
    if (
      input.email &&
      row.email?.toLowerCase() === input.email.toLowerCase()
    ) {
      matchedOn.push("email");
    }
    if (input.phone && row.phone === input.phone) matchedOn.push("phone");
    if (input.whatsappNumber && row.whatsappNumber === input.whatsappNumber) {
      matchedOn.push("whatsapp");
    }
    if (
      input.company &&
      row.company?.toLowerCase() === input.company.toLowerCase()
    ) {
      matchedOn.push("company");
    }
    return {
      id: row.id,
      fullName: row.fullName,
      email: row.email,
      phone: row.phone,
      company: row.company,
      matchedOn,
    };
  });
}
