import { MemberStatus, Prisma, RecordStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { systemRolePermissions } from "@/lib/permissions/catalog";
import { createSystemNotification } from "@/lib/notifications/create";
import { getReorderSuggestions } from "@/features/inventory/stock";

/** Active members of the company holding any of the permissions (owners always). */
async function recipients(organizationId: string, companyId: string, permissions: string[]) {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, status: MemberStatus.ACTIVE },
    include: {
      role: { include: { permissions: { include: { permission: { select: { code: true } } } } } },
      scopes: { where: { companyId }, select: { id: true } },
    },
  });
  return members
    .filter((m) => {
      if (m.isOwner) return true;
      if (m.scopes.length === 0) return false;
      const granted = new Set([
        ...m.role.permissions.map((rp) => rp.permission.code),
        ...(m.role.isSystem ? systemRolePermissions(m.role.code) : []),
      ]);
      return permissions.some((p) => granted.has(p));
    })
    .map((m) => m.userId);
}

/**
 * Job: notify purchasers/inventory managers about products at or below their reorder
 * level. A user is not re-notified about a product while the previous alert is unread.
 */
export async function sendLowStockAlerts() {
  const companies = await prisma.company.findMany({ where: { status: RecordStatus.ACTIVE }, select: { id: true, organizationId: true, code: true } });
  let sent = 0;
  for (const company of companies) {
    const suggestions = await getReorderSuggestions({ organizationId: company.organizationId }, company.id);
    if (suggestions.length === 0) continue;
    const users = await recipients(company.organizationId, company.id, ["purchase_order.create", "inventory.administer"]);
    for (const s of suggestions) {
      for (const userId of users) {
        const open = await prisma.notification.count({
          where: {
            userId,
            type: "stock.low",
            readAt: null,
            AND: [
              { data: { path: ["productId"], equals: s.product.id } },
              { data: { path: ["companyId"], equals: company.id } },
            ],
          },
        });
        if (open > 0) continue;
        await createSystemNotification({
          organizationId: company.organizationId,
          userId,
          type: "stock.low",
          title: `Low stock: ${s.product.sku} ${s.product.name}`,
          body: `${company.code}: ${s.available} ${s.product.uom} available, reorder level ${s.reorderLevel}. Suggested order ${s.suggestedQuantity}.`,
          data: { productId: s.product.id, companyId: company.id, href: "/inventory/reorder" } as Prisma.InputJsonValue,
        });
        sent += 1;
      }
    }
  }
  return { sent };
}
