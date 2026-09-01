-- Supabase Storage bucket for chat attachments
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-attachments',
  'chat-attachments',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "chat_attachments_org_member_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'chat-attachments'
    AND EXISTS (
      SELECT 1 FROM "organization_members" om
      WHERE om."userId" = auth.uid()
        AND om.status = 'ACTIVE'
        AND (storage.foldername(name))[1] = om."organizationId"
    )
  );

CREATE POLICY "chat_attachments_org_member_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'chat-attachments'
    AND EXISTS (
      SELECT 1 FROM "organization_members" om
      WHERE om."userId" = auth.uid()
        AND om.status = 'ACTIVE'
        AND (storage.foldername(name))[1] = om."organizationId"
    )
  );
