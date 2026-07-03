// apps/api/src/services/auditActions.ts
// Centralised audit action names. PR4 introduces device.self_revoked for the
// daemon-side DELETE /v1/devices/me path; future PRs should migrate existing
// audit action strings here as they touch the relevant call sites.
//
// The auditLogs.action column is a free-text `text` (see packages/db/src/schema/
// audit.ts) so no DB-side enum / CHECK constraint needs to follow this file.
export const AUDIT_ACTIONS = {
  DEVICE_SELF_REVOKED: "device.self_revoked",
  DEVICE_AUTH_APPROVED: "device_auth.approved",
  DEVICE_AUTH_DENIED: "device_auth.denied",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
