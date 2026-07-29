import type { Queryable } from '../db/pool.js';

export interface AuditInput {
  readonly actorId: string | null;
  readonly actorEmail: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * Registra una acción administrativa. La tabla es append-only por trigger: el
 * admin no puede borrar su propio rastro, que era exactamente el agujero del
 * panel de APTraslados.
 */
export async function recordAudit(tx: Queryable, input: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id,
                            before, after, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.actorId, input.actorEmail, input.action, input.targetType, input.targetId,
      input.before === null ? null : JSON.stringify(input.before),
      input.after === null ? null : JSON.stringify(input.after),
      input.ip, input.userAgent,
    ],
  );
}
