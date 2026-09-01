import { createAdminClient } from "@/lib/supabase/admin";

const MAX_SIZE = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "video/webm",
]);

export function validateCallRecording(mimeType: string, size: number) {
  if (size > MAX_SIZE) {
    throw new Error("Recording exceeds 25MB limit");
  }
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new Error("Only audio recordings are allowed");
  }
}

export async function uploadCallRecording(input: {
  organizationId: string;
  leadId: string;
  callRecordId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}) {
  validateCallRecording(input.mimeType, input.buffer.length);

  const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${input.organizationId}/${input.leadId}/${input.callRecordId}/${safeName}`;
  const supabase = createAdminClient();
  const { error } = await supabase.storage
    .from("call-recordings")
    .upload(path, input.buffer, {
      contentType: input.mimeType,
      upsert: false,
    });

  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from("call-recordings").getPublicUrl(path);
  return data.publicUrl;
}
