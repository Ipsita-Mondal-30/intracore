import { NextResponse } from "next/server";
import { JOBS, runJobs } from "@/lib/jobs";
import { isCronAuthorized } from "@/lib/cron-auth";

/** Vercel Hobby allows up to 60 s (default 10 s). */
export const maxDuration = 60;

/**
 * Runs background jobs: ?job=name (repeatable) or all jobs when omitted.
 * Requires `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends this header).
 */
async function handle(req: Request) {
  if (!isCronAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  }
  const requested = new URL(req.url).searchParams.getAll("job");
  const unknown = requested.filter((name) => !JOBS[name]);
  if (unknown.length > 0) {
    return NextResponse.json(
      { ok: false, error: `Unknown job: ${unknown.join(", ")}`, code: "VALIDATION_ERROR" },
      { status: 422 },
    );
  }
  const results = await runJobs(requested.length > 0 ? requested : Object.keys(JOBS));
  return NextResponse.json({ ok: true, data: results });
}

export const GET = handle;
export const POST = handle;
