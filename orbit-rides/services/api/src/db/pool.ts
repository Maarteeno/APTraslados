/**
 * Acceso a Postgres.
 *
 * Todo lo que toca dinero pasa por `withTransaction`. Y las transacciones que
 * insertan en el ledger usan SET CONSTRAINTS ALL IMMEDIATE al final, para que
 * la invariante de suma cero explote acá adentro y no en un COMMIT silencioso.
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { loadConfig } from '../config/index.js';
import { logger } from '../lib/logger.js';

const config = loadConfig();

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'orbit-api',
});

pool.on('error', (err) => {
  // Un cliente idle que muere no debe tumbar el proceso.
  logger.error({ err }, 'error en cliente idle del pool de Postgres');
});

export interface Queryable {
  query<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export const db: Queryable = {
  query: <T extends QueryResultRow>(sql: string, params: readonly unknown[] = []) =>
    pool.query<T>(sql, params as unknown[]).then((r) => ({ rows: r.rows, rowCount: r.rowCount })),
};

function wrap(client: PoolClient): Queryable {
  return {
    query: <T extends QueryResultRow>(sql: string, params: readonly unknown[] = []) =>
      client.query<T>(sql, params as unknown[]).then((r) => ({ rows: r.rows, rowCount: r.rowCount })),
  };
}

/** Transacción con rollback automático ante cualquier excepción. */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(wrap(client));
    // Fuerza la verificación de los constraint triggers diferidos (ledger)
    // ANTES del COMMIT, para poder hacer rollback con un error entendible.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'falló el ROLLBACK');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function healthcheck(): Promise<boolean> {
  try {
    const r = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    return r.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
