-- Run in the Supabase SQL editor (these are not applied by `prisma migrate deploy`).
-- Private buckets used by the app; files are only served through short-lived signed URLs.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES
  ('documents', 'documents', false, 20971520),
  ('lead-call-recordings', 'lead-call-recordings', false, 26214400)
ON CONFLICT (id) DO UPDATE SET public = false;

-- 20260901180000 created an unused *public* bucket; nothing reads from it, so close it.
UPDATE storage.buckets SET public = false WHERE id = 'call-recordings';
