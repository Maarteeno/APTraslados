/**
 * Plugin de autenticación y autorización.
 *
 * Regla que no se negocia: el ROL viene de la base de datos, nunca del token.
 * Un cliente puede fabricar claims; no puede fabricar una fila.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadConfig } from '../config/index.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { db } from '../db/pool.js';
import { extractBearer, verifyDevToken, type Principal, type Role } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

interface UserRow {
  id: string;
  role: Role;
  city_id: string | null;
  status: 'active' | 'suspended' | 'deleted';
}

async function loadPrincipal(userId: string): Promise<Principal> {
  const { rows } = await db.query<UserRow>(
    `SELECT id, role, city_id, status FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  const user = rows[0];
  if (!user) throw new UnauthorizedError('el usuario del token no existe');
  if (user.status !== 'active') throw new ForbiddenError(`cuenta ${user.status}`);
  return { userId: user.id, role: user.role, cityId: user.city_id };
}

export async function authenticate(request: FastifyRequest): Promise<Principal> {
  const config = loadConfig();
  const token = extractBearer(request.headers.authorization);

  let subject: string;
  if (config.AUTH_MODE === 'dev') {
    subject = verifyDevToken(token).sub;
  } else {
    // Enganche para Firebase Admin. Se deja explícito en vez de silenciosamente
    // permisivo: si alguien despliega con AUTH_MODE=firebase sin implementarlo,
    // el servicio rechaza todo en vez de dejar pasar todo.
    throw new UnauthorizedError('AUTH_MODE=firebase todavía no está implementado');
  }

  const principal = await loadPrincipal(subject);
  request.principal = principal;
  return principal;
}

export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) throw new UnauthorizedError();
  return request.principal;
}

export function requireRole(request: FastifyRequest, ...roles: readonly Role[]): Principal {
  const principal = requirePrincipal(request);
  if (!roles.includes(principal.role)) {
    throw new ForbiddenError(`esta operación requiere rol: ${roles.join(' o ')}`);
  }
  return principal;
}

/** Registra el hook. Las rutas públicas se marcan con config.public = true. */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.decorateRequest('principal', undefined);

  app.addHook('onRequest', async (request) => {
    // Sin ruta que haya matcheado, no hay nada que autorizar: dejamos pasar
    // para que el notFoundHandler devuelva un 404 con nuestro formato.
    //
    // Si no se hace esto, el hook autentica ANTES del ruteo y una URL que no
    // existe responde 401 en vez de 404. No es un agujero de seguridad —no
    // ejecuta nada—, pero vuelve indepurable la integración: el cliente no
    // puede distinguir "escribí mal la URL" de "mi token venció". Y de paso
    // convierte al notFoundHandler en código muerto.
    if (!request.routeOptions.url) return;

    const routeConfig = request.routeOptions.config as { public?: boolean } | undefined;
    if (routeConfig?.public) return;

    await authenticate(request);
  });
}
