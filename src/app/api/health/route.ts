import { NextResponse } from "next/server";
import { getMissingEnvVars, hasSupabasePublicEnv } from "@/lib/config/env";
import { isEmailConfigured } from "@/lib/email/client";
import { prisma } from "@/lib/db/prisma";

export async function GET(request: Request) {
  const missing = getMissingEnvVars();
  const url = new URL(request.url);
  const checkDb = url.searchParams.get("db") === "1";

  const payload: Record<string, unknown> = {
    status: missing.length === 0 ? "ok" : "misconfigured",
    service: "intracore",
    supabasePublic: hasSupabasePublicEnv(),
    emailConfigured: isEmailConfigured(),
    missingEnv: missing,
    vercel: process.env.VERCEL === "1",
    timestamp: new Date().toISOString(),
  };

  if (checkDb) {
    try {
      const cols = await prisma.$queryRaw<
        { table_name: string; column_name: string }[]
      >`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'leads' AND column_name IN ('reEngagedAt', 'reengagedAt', 'callbackAt'))
            OR (table_name = 'lead_follow_ups' AND column_name IN ('remindedAt'))
            OR (table_name = 'lead_call_records' AND column_name IN ('didNumber', 'recordingPath', 'did', 'recordingUrl'))
          )
        ORDER BY table_name, column_name
      `;
      await prisma.lead.findFirst({
        select: { id: true, reEngagedAt: true, status: true },
      });
      payload.db = {
        ok: true,
        columns: cols,
        leadProbeOk: true,
      };
    } catch (error) {
      payload.status = "db_error";
      payload.db = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return NextResponse.json(payload);
}
