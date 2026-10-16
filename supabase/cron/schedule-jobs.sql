-- Background-job schedule for Vercel Hobby (whose own cron runs at most once a day).
-- Supabase pg_cron calls the app's job runner over HTTP (pg_net) every minute / 15 minutes.
-- The daily run of every job stays in vercel.json.
--
-- Run ONCE in the Supabase SQL editor of the production project, after:
--   1. setting CRON_SECRET in Vercel (Settings → Environment Variables) and redeploying;
--   2. pasting the same CRON_SECRET below (and changing app_url if the domain changes). Values live in Supabase Vault (encrypted),
--      never in this repo.
-- Re-running is safe: secrets are upserted and the schedules replaced.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- ── 1. Secrets (edit these two values) ────────────────────────────────────────
do $$
declare
  app_url text := 'https://intracore-tw2j.vercel.app';   -- production URL, no trailing slash
  cron_secret text := 'PASTE-THE-SAME-CRON_SECRET-AS-VERCEL';
begin
  if app_url like '%YOUR-APP%' or cron_secret like 'PASTE-%' then
    raise exception 'Replace app_url and cron_secret before running this script';
  end if;
  delete from vault.secrets where name in ('intracore_app_url', 'intracore_cron_secret');
  perform vault.create_secret(app_url, 'intracore_app_url', 'IntraCore production URL for scheduled jobs');
  perform vault.create_secret(cron_secret, 'intracore_cron_secret', 'Bearer token for /api/v1/jobs/run');
end $$;

-- ── 2. One function that calls the job runner with the secret header ─────────
create or replace function public.intracore_run_jobs(jobs text[])
returns bigint
language sql
security definer
set search_path = ''
as $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'intracore_app_url')
           || '/api/v1/jobs/run?' || array_to_string(array(select 'job=' || j from unnest(jobs) j), '&'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'intracore_cron_secret')
    ),
    timeout_milliseconds := 60000
  );
$$;
revoke all on function public.intracore_run_jobs(text[]) from public, anon, authenticated;

-- ── 3. Schedules ──────────────────────────────────────────────────────────────
select cron.unschedule(jobname) from cron.job where jobname like 'intracore-%';

-- Message delivery and retries, workflows, reminders, scheduled campaigns.
select cron.schedule('intracore-every-minute', '* * * * *',
  $$ select public.intracore_run_jobs(array['background-queue', 'workflow-dispatch', 'reminders', 'campaign-scheduler']) $$);

-- SLA and approval escalations, task reminders.
select cron.schedule('intracore-every-15-minutes', '*/15 * * * *',
  $$ select public.intracore_run_jobs(array['ticket-escalation', 'approval-escalation', 'task-reminders', 'follow-up-reminder-emails']) $$);

-- ── Check ─────────────────────────────────────────────────────────────────────
-- Scheduled:      select jobname, schedule, active from cron.job where jobname like 'intracore-%';
-- Last HTTP calls: select status_code, left(content, 200), created from net._http_response order by created desc limit 10;
--                  (200 = ran; 401 = CRON_SECRET in Vault ≠ the one in Vercel)
-- Stop:           select cron.unschedule(jobname) from cron.job where jobname like 'intracore-%';
