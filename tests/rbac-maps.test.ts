import { describe, expect, it } from "vitest";
import {
  SYSTEM_ROLE_TEMPLATES,
  systemRolePermissions,
  type SystemRoleTemplate,
} from "@/lib/permissions/catalog";

const resolvePermissions = (template: SystemRoleTemplate) =>
  systemRolePermissions(template.code);

describe("role permission maps", () => {
  it("viewer cannot invite members or manage org", () => {
    const viewer = SYSTEM_ROLE_TEMPLATES.find((r) => r.code === "viewer")!;
    const perms = new Set(resolvePermissions(viewer));
    expect(perms.has("dashboard.view")).toBe(true);
    expect(perms.has("member.invite")).toBe(false);
    expect(perms.has("org.manage")).toBe(false);
  });

  it("sales_executive cannot view_all leads", () => {
    const role = SYSTEM_ROLE_TEMPLATES.find(
      (r) => r.code === "sales_executive",
    )!;
    const perms = new Set(resolvePermissions(role));
    expect(perms.has("lead.view")).toBe(true);
    expect(perms.has("lead.view_all")).toBe(false);
    expect(perms.has("lead.assign")).toBe(false);
  });

  it("admin includes integration.manage", () => {
    const admin = SYSTEM_ROLE_TEMPLATES.find((r) => r.code === "admin")!;
    const perms = new Set(resolvePermissions(admin));
    expect(perms.has("integration.manage")).toBe(true);
    expect(perms.has("role.manage")).toBe(true);
  });
});
