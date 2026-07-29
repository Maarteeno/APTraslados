/**
 * Este test existe por un bug concreto.
 *
 * `migrate.ts` resolvía el directorio de migraciones con `../migrations`
 * relativo al script. Funcionaba corriendo con tsx desde `scripts/`, y fallaba
 * en la imagen corriendo desde `dist/scripts/`, donde apuntaba a
 * `dist/migrations` — que no existe. El contenedor moría con
 * `ENOENT: scandir '/repo/services/api/dist/migrations'`.
 *
 * Ningún test lo detectaba porque todos corren sobre el código fuente. Este
 * cubre los dos layouts explícitamente.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findResourceDir, resourceDirCandidates, ResourceNotFoundError } from '../src/lib/paths.js';

describe('candidatos de búsqueda', () => {
  it('incluye el layout compilado y el de fuente, en ese orden', () => {
    const candidates = resourceDirCandidates(join(sep, 'repo', 'services', 'api', 'dist', 'scripts'), 'migrations');
    expect(candidates[0]).toBe(join(sep, 'repo', 'services', 'api', 'migrations'));
    expect(candidates[1]).toBe(join(sep, 'repo', 'services', 'api', 'dist', 'migrations'));
  });

  it('no devuelve duplicados ni rutas vacías', () => {
    const candidates = resourceDirCandidates(join(sep, 'a', 'b', 'c'), 'x');
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.every((c) => c.length > 0)).toBe(true);
  });
});

describe('resolución real sobre disco', () => {
  /** Arma services/api con migrations/ y opcionalmente dist/scripts/. */
  function makeTree(withDist: boolean): { scriptDir: string; migrationsDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'orbit-paths-'));
    const api = join(root, 'services', 'api');
    const migrationsDir = join(api, 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, '0001_init.sql'), 'SELECT 1;');
    const scriptDir = withDist ? join(api, 'dist', 'scripts') : join(api, 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    return { scriptDir, migrationsDir };
  }

  it('encuentra migrations desde dist/scripts (layout de la imagen)', () => {
    const { scriptDir, migrationsDir } = makeTree(true);
    const moduleUrl = pathToFileURL(join(scriptDir, 'migrate.js')).href;
    expect(findResourceDir(moduleUrl, 'migrations')).toBe(migrationsDir);
  });

  it('encuentra migrations desde scripts (layout de fuente con tsx)', () => {
    const { scriptDir, migrationsDir } = makeTree(false);
    const moduleUrl = pathToFileURL(join(scriptDir, 'migrate.ts')).href;
    expect(findResourceDir(moduleUrl, 'migrations')).toBe(migrationsDir);
  });

  it('si no existe, el error dice dónde buscó', () => {
    const { scriptDir } = makeTree(true);
    const moduleUrl = pathToFileURL(join(scriptDir, 'migrate.js')).href;
    let caught: unknown;
    try {
      findResourceDir(moduleUrl, 'no-existe-esta-carpeta');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResourceNotFoundError);
    const message = (caught as Error).message;
    expect(message).toContain('no-existe-esta-carpeta');
    // El mensaje tiene que listar las rutas probadas: sin eso, depurar esto en
    // un contenedor es adivinar.
    expect(message.split('\n').length).toBeGreaterThan(2);
  });
});
