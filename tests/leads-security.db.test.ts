import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { addNoteAction } from "@/features/leads/workflow-actions";
import { changeLeadStageAction, updateLeadAction } from "@/features/leads/actions";
import { inviteMemberAction } from "@/features/members/actions";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: () => unknown) => fn,
}));

let a: OrgFixture;
let b: OrgFixture;
let exec: { userId: string };
let othersLead: { id: string };
let ownLead: { id: string };

const form = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};

beforeAll(async () => {
  a = await createOrg("LeadSec");
  b = await createOrg("Other");
  exec = await a.addMember("sales_executive");
  othersLead = await prisma.lead.create({
    data: { organizationId: a.org.id, fullName: "Not Mine", phone: "9000000001", assignedUserId: a.ownerId },
  });
  ownLead = await prisma.lead.create({
    data: { organizationId: a.org.id, fullName: "Mine", phone: "9000000002", assignedUserId: exec.userId },
  });
});
afterAll(cleanupFixtures);

describe("lead write paths respect record visibility", () => {
  it("blocks writes to leads the member cannot see", async () => {
    await signInAs(exec.userId);
    const denied = await addNoteAction(null, form({ leadId: othersLead.id, content: "sneaky" }));
    expect(denied).toEqual({ ok: false, error: "Lead not found" });
    const allowed = await addNoteAction(null, form({ leadId: ownLead.id, content: "fine" }));
    expect(allowed.ok).toBe(true);
  });

  it("requires lead.convert to move a lead into a won stage", async () => {
    await signInAs(exec.userId);
    const won = await prisma.leadStage.findFirst({ where: { organizationId: a.org.id, isWon: true } });
    expect(won).toBeTruthy();
    // sales_executive has lead.convert by template; a viewer-like role must not.
    const res = await changeLeadStageAction(ownLead.id, won!.id);
    expect(res.ok).toBe(true);

    const support = await a.addMember("support_executive");
    await prisma.lead.update({ where: { id: ownLead.id }, data: { assignedUserId: support.userId } });
    await signInAs(support.userId);
    const blocked = await changeLeadStageAction(ownLead.id, won!.id);
    expect(blocked.ok).toBe(false);
  });

  it("rejects another tenant's stage on lead update", async () => {
    await signInAs(a.ownerId);
    const foreignStage = await prisma.leadStage.findFirstOrThrow({ where: { organizationId: b.org.id } });
    const source = await prisma.leadSource.findFirstOrThrow({ where: { organizationId: a.org.id } });
    const res = await updateLeadAction(
      null,
      form({ leadId: othersLead.id, firstName: "Not", phone: "9000000001", sourceId: source.id, stageId: foreignStage.id }),
    );
    expect(res).toMatchObject({ ok: false, code: "INVALID_REFERENCE" });
  });
});

describe("invitations cannot escalate privileges", () => {
  it("blocks inviting to a role with more access than the inviter", async () => {
    const custom = await prisma.role.create({
      data: { organizationId: a.org.id, code: "inviter", name: "Inviter" },
    });
    const invitePerm = await prisma.permission.findUniqueOrThrow({ where: { code: "member.invite" } });
    await prisma.rolePermission.create({ data: { roleId: custom.id, permissionId: invitePerm.id } });
    const inviter = await a.addMember("viewer");
    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: a.org.id, userId: inviter.userId } },
      data: { roleId: custom.id },
    });

    await signInAs(inviter.userId);
    const adminRole = a.roles.get("admin")!;
    const res = await inviteMemberAction(null, form({ email: "new@test.local", roleId: adminRole }));
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/more access than your own/) });

    await signInAs((await a.addMember("admin")).userId);
    const ownerInvite = await inviteMemberAction(null, form({ email: "own@test.local", roleId: a.roles.get("owner")! }));
    expect(ownerInvite).toMatchObject({ ok: false, error: expect.stringMatching(/more access/) });
  });
});
