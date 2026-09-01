import { createAdminClient } from "@/lib/supabase/admin";

const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export function validateAttachment(mimeType: string, size: number) {
  if (size > MAX_SIZE) {
    throw new Error("File exceeds 10MB limit");
  }
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new Error("File type not allowed");
  }
}

export async function uploadChatAttachment(input: {
  organizationId: string;
  conversationId: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}) {
  validateAttachment(input.mimeType, input.buffer.length);

  const path = `${input.organizationId}/${input.conversationId}/${input.messageId}/${input.fileName}`;
  const supabase = createAdminClient();
  const { error } = await supabase.storage
    .from("chat-attachments")
    .upload(path, input.buffer, {
      contentType: input.mimeType,
      upsert: false,
    });

  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from("chat-attachments").getPublicUrl(path);
  return {
    fileUrl: data.publicUrl,
    path,
  };
}
