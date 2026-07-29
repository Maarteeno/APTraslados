/**
 * Runner de migraciones.
 *
 * Simple a propósito: archivos .sql numerados, aplicados en orden, uno por
 * transacción, registrados en schema_migrations. Sin down-migrations: revertir
 * en producción se hace con una migración nueva, no deshaciendo la anterior.
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pool } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';
import { findResourceDir } from '../src/lib/paths.js';

// Se resuelve buscando, no con una ruta relativa fija: el script corre desde
// `scripts/` con tsx y desde `dist/scripts/` en la imagen, y una ruta fija
// funciona en uno y falla en el otro.
const MIGRATIONS_DIR = findResourceDir(import.meta.url, 'migrations');

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function main(): Promise<void> {
  await ensureTable();

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ filename: string; checksum: string }>(
    `SELECT filename, checksum FROM schema_migrations`,
  );
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

  let ran = 0;
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
    const previous = applied.get(file);

    if (previous !== undefined) {
      if (previous !== checksum) {
        // Editar una migración ya aplicada rompe la reproducibilidad del esquema.
        throw new Error(
          `la migración ${file} ya se aplicó pero su contenido cambió ` +
          `(${previous} → ${checksum}). Creá una migración nueva en vez de editar esta.`,
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
        [file, checksum],
      );
      await client.query('COMMIT');
      logger.info({ file }, 'migración aplicada');
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, file }, 'falló la migración: se revirtió');
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info({ applied: ran, total: files.length, dir: MIGRATIONS_DIR }, ran === 0 ? 'el esquema ya estaba al día' : 'migraciones completas');
  await pool.end();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'las migraciones fallaron');
  process.exit(1);
});
