export function isResendConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() &&
      process.env.RESEND_FROM_EMAIL?.trim(),
  );
}

export function getResendFromEmail() {
  return process.env.RESEND_FROM_EMAIL?.trim() ?? "";
}

export function getCronSecret() {
  return process.env.CRON_SECRET?.trim() ?? "";
}
