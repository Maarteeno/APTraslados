/**
 * Persistencia del ledger.
 *
 * El dominio construye la transacción (y valida la suma cero); acá solo se
 * escribe. La base tiene además su propio trigger diferido, así que la
 * invariante está protegida dos veces: en el código y en el motor.
 */

import type { Queryable } from '../db/pool.js';
import { ConflictError } from '../lib/errors.js';
import type { AccountKind, CurrencyCode, LedgerTransaction } from '@orbit/domain';

/** Crea la cuenta si no existe y devuelve su id. Idempotente. */
export async function ensureAccount(
  tx: Queryable,
  kind: AccountKind,
  ownerId: string | null,
  currency: CurrencyCode,
): Promise<string> {
  if (ownerId === null) {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM accounts WHERE owner_id IS NULL AND kind = $1 AND currency = $2`,
      [kind, currency],
    );
    const found = existing.rows[0];
    if (found) return found.id;
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO accounts (owner_id, kind, currency) VALUES (NULL, $1, $2) RETURNING id`,
      [kind, currency],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('no se pudo crear la cuenta de plataforma');
    return row.id;
  }

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO accounts (owner_id, kind, currency) VALUES ($1, $2, $3)
     ON CONFLICT (owner_id, kind, currency) WHERE owner_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [ownerId, kind, currency],
  );
  const row = inserted.rows[0];
  if (row) return row.id;

  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM accounts WHERE owner_id = $1 AND kind = $2 AND currency = $3`,
    [ownerId, kind, currency],
  );
  const found = existing.rows[0];
  if (!found) throw new Error('no se pudo obtener la cuenta del usuario');
  return found.id;
}

/**
 * Escribe todas las patas. Si la clave de idempotencia ya existe, no duplica:
 * devuelve false y el llamador sabe que era un reintento.
 */
export async function postTransaction(tx: Queryable, transaction: LedgerTransaction): Promise<boolean> {
  const already = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ledger_entries WHERE idempotency_key = $1`,
    [transaction.idempotencyKey],
  );
  if (Number(already.rows[0]?.n ?? '0') > 0) return false;

  for (const line of transaction.lines) {
    const accountId = await ensureAccount(tx, line.accountKind, line.ownerId, transaction.currency);
    try {
      await tx.query(
        `INSERT INTO ledger_entries
           (transaction_id, account_id, amount_cents, currency, ref_type, ref_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          transaction.transactionId, accountId, line.amountCents, transaction.currency,
          transaction.refType, transaction.refId, transaction.idempotencyKey,
        ],
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        throw new ConflictError('esta operación ya fue asentada en el ledger');
      }
      throw err;
    }
  }
  return true;
}

export async function getBalanceCents(
  tx: Queryable,
  kind: AccountKind,
  ownerId: string | null,
  currency: CurrencyCode,
): Promise<number> {
  const { rows } = await tx.query<{ balance_cents: string }>(
    `SELECT COALESCE(balance_cents, 0)::text AS balance_cents
       FROM account_balances
      WHERE kind = $1 AND currency = $2
        AND (($3::uuid IS NULL AND owner_id IS NULL) OR owner_id = $3::uuid)`,
    [kind, currency, ownerId],
  );
  return Number(rows[0]?.balance_cents ?? '0');
}

/** Chequeo de integridad para el job de conciliación y para los tests. */
export async function findUnbalancedTransactions(
  tx: Queryable,
): Promise<Array<{ transaction_id: string; total: string }>> {
  const { rows } = await tx.query<{ transaction_id: string; total: string }>(
    `SELECT transaction_id, SUM(amount_cents)::text AS total
       FROM ledger_entries
      GROUP BY transaction_id
     HAVING SUM(amount_cents) <> 0`,
  );
  return rows;
}
