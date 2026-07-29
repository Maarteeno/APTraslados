/**
 * Arranque real del servidor.
 *
 * Usa `app.inject()` de Fastify: construye la instancia completa (helmet, cors,
 * rate limit, websocket, hook de auth, manejador de errores, todas las rutas) y
 * le mete requests sin abrir un puerto ni tocar la base.
 *
 * Verifica lo que un test unitario no puede: que el cableado esté bien. Un
 * plugin registrado en el orden equivocado o una ruta declarada dos veces
 * revienta acá y no en producción.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { closeRedis } from '../src/db/redis.js';
import { closePool } from '../src/db/pool.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // Los clientes de Postgres y Redis se cierran para que vitest no quede colgado.
  await Promise.allSettled([closePool(), closeRedis()]);
});

describe('arranque del servidor', () => {
  it('construye la instancia con todos los plugins', () => {
    expect(app).toBeDefined();
  });

  it('registra las rutas esperadas', () => {
    const routes = app.printRoutes({ commonPrefix: false });
    for (const path of [
      '/health',
      '/v1/auth/dev-login',
      '/v1/quotes',
      '/v1/trips',
      '/v1/me',
      '/v1/driver/position',
      '/v1/driver/offer',
      '/v1/driver/earnings',
    ]) {
      expect(routes, `falta la ruta ${path}`).toContain(path.replace(/^\//, ''));
    }
  });

  it('/health responde sin tocar la base', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('aplica las cabeceras de seguridad de helmet', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});

describe('autenticación en el borde', () => {
  it('una ruta protegida sin token devuelve 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('rechaza un Authorization mal formado', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/me',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rechaza un token con firma inválida', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/me',
      headers: { authorization: 'Bearer eyJzdWIiOiJhZG1pbiJ9.firmafalsa' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('crear un viaje sin token es 401, no 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/trips',
      payload: { quoteId: '00000000-0000-4000-8000-000000000000', paymentMethod: 'cash' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('validación de entrada', () => {
  it('el login de dev valida el formato E.164 antes de consultar la base', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/dev-login',
      payload: { phone: '099123456' },   // sin +598
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; details: { issues: Array<{ path: string }> } } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.details.issues[0]?.path).toBe('phone');
  });

  it('rechaza un body vacío donde hace falta uno', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * Estos tests existen por un fallo del smoke en el paso 10.
 *
 * `POST /v1/trips/:id/accept` no lleva body, pero el cliente mandaba
 * `Content-Type: application/json`. Fastify respondía "Body cannot be empty" y
 * mi manejador de errores, que ignoraba el statusCode de los errores ajenos, lo
 * convertía en un 500.
 *
 * Dos defectos en uno: el servidor era innecesariamente estricto, y un error de
 * cliente se reportaba como error de servidor. Lo segundo es lo grave: los 500
 * disparan alertas, y si un cliente mal escrito los genera, los 500 de verdad
 * se pierden en el ruido.
 */
describe('body vacío y content-type', () => {
  it('un POST sin body pero con Content-Type JSON no da 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/trips/00000000-0000-4000-8000-000000000000/accept',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    // Sin token corresponde 401. Lo importante es que NO sea 500.
    expect(res.statusCode).toBe(401);
  });

  it('un body vacío se trata como objeto vacío y lo valida zod', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('JSON malformado da 400, no 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      headers: { 'content-type': 'application/json' },
      payload: '{ esto no es json',
    });
    expect(res.statusCode).toBe(400);
  });

  it('un body válido sigue funcionando', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { phone: '+59899100001' },
    });
    // 404 porque no hay base en estos tests; lo que importa es que el body
    // pasó la validación y llegó al handler.
    expect([404, 500]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(400);
  });

  it('un content-type no soportado da 415, no 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('manejo de errores', () => {
  it('una ruta inexistente devuelve 404 con nuestro formato', async () => {
    const res = await app.inject({ method: 'GET', url: '/no/existe' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('todas las respuestas de error tienen la misma forma', async () => {
    for (const url of ['/no/existe', '/v1/me']) {
      const res = await app.inject({ method: 'GET', url });
      const body = res.json() as { error?: { code?: string; message?: string } };
      expect(body.error, `${url} sin objeto error`).toBeDefined();
      expect(typeof body.error?.code).toBe('string');
      expect(typeof body.error?.message).toBe('string');
    }
  });
});
