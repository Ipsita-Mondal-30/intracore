import { putObject, removeObject, signedObjectUrl } from "@/lib/storage/objects";
import { AppError } from "@/lib/errors";

export const CALL_RECORDING_BUCKET = "lead-call-recordings";
export const CALL_RECORDING_MAX_BYTES = 25 * 1024 * 1024;

export const ALLOWED_CALL_RECORDING_MIME_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/webm",
  "audio/x-m4a",
] as const;

export type AllowedCallRecordingMimeType =
  (typeof ALLOWED_CALL_RECORDING_MIME_TYPES)[number];

const MIME_TO_EXT: Record<AllowedCallRecordingMimeType, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a",
};

export function validateCallRecordingFile(file: {
  type: string;
  size: number;
}): { mimeType: AllowedCallRecordingMimeType; ext: string } {
  if (
    !ALLOWED_CALL_RECORDING_MIME_TYPES.includes(
      file.type as AllowedCallRecordingMimeType,
    )
  ) {
    throw new AppError(
      "INVALID_FILE",
      "Unsupported audio format. Allowed: MP3, WAV, M4A, WebM",
      400,
    );
  }
  if (file.size > CALL_RECORDING_MAX_BYTES) {
    throw new AppError(
      "FILE_TOO_LARGE",
      "Recording must be 25MB or less",
      400,
    );
  }
  const mimeType = file.type as AllowedCallRecordingMimeType;
  return { mimeType, ext: MIME_TO_EXT[mimeType] };
}

export function buildCallRecordingPath(
  organizationId: string,
  leadId: string,
  callRecordId: string,
  ext: string,
): string {
  return `${organizationId}/${leadId}/${callRecordId}.${ext}`;
}

export const uploadCallRecording = (path: string, body: ArrayBuffer | Buffer, mimeType: string) =>
  putObject(CALL_RECORDING_BUCKET, path, body, mimeType);

export const getCallRecordingSignedUrl = (path: string, expiresInSec = 3600) =>
  signedObjectUrl(CALL_RECORDING_BUCKET, path, expiresInSec);

export const deleteCallRecording = (path: string) => removeObject(CALL_RECORDING_BUCKET, path);
