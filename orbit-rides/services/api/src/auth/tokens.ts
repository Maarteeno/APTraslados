/**
 * Tokens de sesión.
 *
 * Dos modos, elegidos por AUTH_MODE:
 *
 *   dev      — el API firma y verifica sus propios tokens HMAC. Sirve para
 *              desarrollar y para probar desde el emulador sin depender de
 *              Firebase. Prohibido en producción (lo valida la config).
 *   firebase — se verifica el ID token de Firebase. El rol NUNCA sale del
 *              token del cliente: se lee de la base. Es la lección directa de
 *              APTraslados, donde el admin era un email hardcodeado.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { UnauthorizedError } from '../lib/errors.js';

export type Role = 'rider' | 'driver' | 'admin' | 'support';

export interface TokenClaims {
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
}

export interface Principal {
  readonly userId: string;
  readonly role: Role;
  readonly cityId: string | null;
}

const b64u = (buf: Buffer): string => buf.toString('base64url');

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueDevToken(userId: string, now = Date.now()): string {
  const config = loadConfig();
  const claims: TokenClaims = {
    sub: userId,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + config.AUTH_TOKEN_TTL_SECONDS,
  };
  const body = b64u(Buffer.from(JSON.stringify(claims)));
  return `${body}.${sign(body, config.AUTH_DEV_SECRET)}`;
}

export function verifyDevToken(token: string, now = Date.now()): TokenClaims {
  const config = loadConfig();
  const parts = token.split('.');
  if (parts.length !== 2) throw new UnauthorizedError('token mal formado');
  const [body, signature] = parts as [string, string];

  const expected = Buffer.from(sign(body, config.AUTH_DEV_SECRET));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new UnauthorizedError('firma de token inválida');
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    throw new UnauthorizedError('token ilegible');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new UnauthorizedError('token sin sujeto');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) {
    throw new UnauthorizedError('token vencido');
  }
  return claims;
}

export function extractBearer(header: string | undefined): string {
  if (!header) throw new UnauthorizedError('falta el header Authorization');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) throw new UnauthorizedError('formato esperado: Authorization: Bearer <token>');
  return match[1];
}
