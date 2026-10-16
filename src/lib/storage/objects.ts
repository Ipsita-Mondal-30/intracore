import { createAdminClient } from "@/lib/supabase/admin";
import { AppError } from "@/lib/errors";

/**
 * Private Supabase Storage objects. Uploads use the service role server-side;
 * reads go through short-lived signed URLs, never public URLs.
 */
export async function putObject(bucket: string, path: string, body: ArrayBuffer | Buffer, mimeType: string) {
  const { error } = await createAdminClient()
    .storage.from(bucket)
    .upload(path, body, { contentType: mimeType, upsert: true });
  if (error) throw new AppError("UPLOAD_FAILED", error.message, 500);
}

export async function signedObjectUrl(bucket: string, path: string, expiresInSec = 3600) {
  const { data, error } = await createAdminClient()
    .storage.from(bucket)
    .createSignedUrl(path, expiresInSec);
  if (error || !data?.signedUrl) {
    throw new AppError("SIGNED_URL_FAILED", error?.message ?? "Failed to create signed URL", 500);
  }
  return {
    signedUrl: data.signedUrl,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
  };
}

export async function removeObject(bucket: string, path: string) {
  const { error } = await createAdminClient().storage.from(bucket).remove([path]);
  if (error) throw new AppError("DELETE_FAILED", error.message, 500);
}
