/**
 * Resolución de rutas de recursos que viajan con el paquete.
 *
 * El problema concreto: un script se ejecuta desde dos layouts distintos.
 *
 *   con tsx (desarrollo)  services/api/scripts/migrate.ts
 *   compilado (imagen)    services/api/dist/scripts/migrate.js
 *
 * Una ruta relativa fija funciona en uno y falla en el otro. `../migrations`
 * resuelve bien desde `scripts/` y apunta a `dist/migrations` —que no existe—
 * desde `dist/scripts/`. Es un bug que los tests no ven, porque los tests
 * corren sobre el código fuente.
 *
 * La solución es buscar entre los candidatos posibles y fallar con un mensaje
 * que diga exactamente dónde se buscó.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export class ResourceNotFoundError extends Error {}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Candidatos para un directorio de recursos, en orden de preferencia.
 * Exportada aparte de la resolución para poder testearla sin tocar el disco.
 */
export function resourceDirCandidates(scriptDir: string, resourceName: string): string[] {
  return [
    // Layout compilado: dist/scripts/ → services/api/
    resolve(scriptDir, '..', '..', resourceName),
    // Layout de fuente con tsx: scripts/ → services/api/
    resolve(scriptDir, '..', resourceName),
    // Por si el script se mueve un nivel más adentro.
    resolve(scriptDir, '..', '..', '..', resourceName),
  ];
}

/**
 * Encuentra un directorio de recursos que viaja con el paquete, sin importar si
 * corremos desde el fuente o desde dist.
 */
export function findResourceDir(moduleUrl: string, resourceName: string): string {
  const scriptDir = dirname(new URL(moduleUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const candidates = resourceDirCandidates(scriptDir, resourceName);

  for (const candidate of candidates) {
    if (isDirectory(candidate)) return candidate;
  }

  throw new ResourceNotFoundError(
    `no encontré el directorio "${resourceName}". Busqué en:\n` +
      candidates.map((c) => `  ${c}${existsSync(c) ? ' (existe pero no es directorio)' : ''}`).join('\n'),
  );
}

/** Igual que findResourceDir pero para un archivo puntual. */
export function joinResource(dir: string, ...parts: string[]): string {
  return join(dir, ...parts);
}
