import type { SqlFn } from "../config/sql.js";
import { redact } from "./redact.js";

/**
 * Append-only audit log.
 * All significant actions are logged for compliance and debugging.
 * `details` is redacted before persistence to prevent accidental secret leakage.
 */

export type AuditAction =
  | "config.update"
  | "config.encrypt"
  | "memory.write"
  | "memory.compact"
  | "memory.security_block"
  | "skill.create"
  | "skill.edit"
  | "skill.delete"
  | "budget.exceeded"
  | "session.start"
  | "session.auto_reset"
  | "session.compress"
  | "telegram.connect"
  | "telegram.disconnect"
  | "cron.execute"
  | "admin.memory.write"
  | "admin.soul.write"
  | "admin.skill.write"
  | "admin.skill.delete"
  | "admin.config.delete"
  | "hub.install"
  | "hub.uninstall"
  | "hub.auto-update"
  | "session.delete"
  | "session.delete_all"
  | "delegate.complete"
  | "vector.backfill_start";

export function logAudit(
  sql: SqlFn,
  action: AuditAction,
  details?: string
): void {
  const scrubbed = details != null ? redact(details) : null;
  sql`INSERT INTO audit_log (action, details) VALUES (${action}, ${scrubbed})`;
}


