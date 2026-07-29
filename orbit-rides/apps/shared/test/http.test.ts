import { describe, it, expect, vi } from 'vitest';
import { HttpClient, generateId } from '../src/http';
import {
  ApiError, ConflictError, ForbiddenError, NetworkError,
  QuoteExpiredError, UnauthenticatedError, humanMessage,
} from '../src/errors';

interface Recorded { url: string; init: RequestInit | undefined }

/**
 * Captura el error de una promesa que debe rechazar, con el tipo correcto.
 *
 * `promesa.catch(e => e as ApiError)` compila mal: el tipo resultante es
 * `T | ApiError`, porque la promesa también puede resolver. Y si no rechaza, el
 * test tiene que fallar diciéndolo, no seguir con un valor cualquiera.
 */
async function capture(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('se esperaba que la promesa rechazara, y resolvió');
}

function stub(status: number, body: unknown, recorded: Recorded[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    recorded.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as Response;
  };
}

describe('HttpClient', () => {
  it('normaliza la barra final de la baseUrl', () => {
    expect(new HttpClient({ baseUrl: 'http://x:8080///' }).url).toBe('http://x:8080');
  });

  it('no manda Content-Type cuando no hay body', async () => {
    const rec: Recorded[] = [];
    const http = new HttpClient({ baseUrl: 'http://x', fetchImpl: stub(200, { ok: true }, rec) });
    await http.post('/v1/trips/abc/accept');
    const headers = rec[0]?.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(rec[0]?.init?.body).toBeUndefined();
  });

  it('manda Content-Type cuando hay body', async () => {
    const rec: Recorded[] = [];
    const http = new HttpClient({ baseUrl: 'http://x', fetchImpl: stub(200, {}, rec) });
    await http.post('/v1/quotes', { a: 1 });
    const headers = rec[0]?.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('pone Idempotency-Key en los POST y no en los GET', async () => {
    const rec: Recorded[] = [];
    const http = new HttpClient({ baseUrl: 'http://x', fetchImpl: stub(200, {}, rec) });
    await http.post('/a', { x: 1 });
    await http.get('/b');
    expect((rec[0]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect((rec[1]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
  });

  it('respeta una clave de idempotencia explícita, así un reintento no duplica', async () => {
    const rec: Recorded[] = [];
    const http = new HttpClient({ baseUrl: 'http://x', fetchImpl: stub(200, {}, rec) });
    await http.post('/a', undefined, { idempotencyKey: 'accept:trip-1' });
    await http.post('/a', undefined, { idempotencyKey: 'accept:trip-1' });
    const k1 = (rec[0]?.init?.headers as Record<string, string>)['Idempotency-Key'];
    const k2 = (rec[1]?.init?.headers as Record<string, string>)['Idempotency-Key'];
    expect(k1).toBe('accept:trip-1');
    expect(k2).toBe(k1);
  });

  it('agrega el Bearer cuando hay token', async () => {
    const rec: Recorded[] = [];
    const http = new HttpClient({
      baseUrl: 'http://x', fetchImpl: stub(200, {}, rec),
      getToken: async () => 'tok123',
    });
    await http.get('/v1/me');
    expect((rec[0]?.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok123');
  });

  it('no agrega Bearer en las rutas públicas', async () => {
    const rec: Recorded[] = [];
    const http = new HttpClient({
      baseUrl: 'http://x', fetchImpl: stub(200, {}, rec),
      getToken: async () => 'tok123',
    });
    await http.get('/health/ready', false);
    expect((rec[0]?.init?.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('pide el token en cada request y no lo cachea', async () => {
    const tokens = ['a', 'b'];
    const rec: Recorded[] = [];
    const http = new HttpClient({
      baseUrl: 'http://x', fetchImpl: stub(200, {}, rec),
      getToken: async () => tokens.shift() ?? null,
    });
    await http.get('/1');
    await http.get('/2');
    expect((rec[0]?.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer a');
    expect((rec[1]?.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer b');
  });
});

describe('traducción de errores', () => {
  const cases: Array<[number, string, unknown]> = [
    [401, 'unauthorized', UnauthenticatedError],
    [403, 'forbidden', ForbiddenError],
    [409, 'conflict', ConflictError],
    [410, 'gone', QuoteExpiredError],
    [422, 'quote_expired', QuoteExpiredError],
    [500, 'internal_error', ApiError],
  ];

  for (const [status, code, expected] of cases) {
    it(`un ${status} ${code} produce ${(expected as { name: string }).name}`, async () => {
      const http = new HttpClient({
        baseUrl: 'http://x',
        fetchImpl: stub(status, { error: { code, message: 'ups' } }),
      });
      await expect(http.get('/x')).rejects.toBeInstanceOf(expected as never);
    });
  }

  it('conserva status, código, detalles y requestId', async () => {
    const http = new HttpClient({
      baseUrl: 'http://x',
      fetchImpl: stub(400, {
        error: { code: 'bad_request', message: 'faltan campos', details: { issues: [] }, requestId: 'req-9' },
      }),
    });
    const error = await capture(http.get('/x'));
    expect(error.status).toBe(400);
    expect(error.code).toBe('bad_request');
    expect(error.details).toEqual({ issues: [] });
    expect(error.requestId).toBe('req-9');
  });

  it('sobrevive a una respuesta que no es JSON, como el HTML de un proxy', async () => {
    const http = new HttpClient({
      baseUrl: 'http://x',
      fetchImpl: stub(502, '<html>Bad Gateway</html>'),
    });
    const error = await capture(http.get('/x'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.code).toBe('http_502');
  });

  it('avisa una sola vez cuando el token no sirve, para volver al login', async () => {
    const onUnauthenticated = vi.fn();
    const http = new HttpClient({
      baseUrl: 'http://x',
      fetchImpl: stub(401, { error: { code: 'unauthorized', message: 'no' } }),
      onUnauthenticated,
    });
    await http.get('/x').catch(() => undefined);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('un fallo de red es NetworkError, no ApiError', async () => {
    const http = new HttpClient({
      baseUrl: 'http://x',
      fetchImpl: async () => { throw new TypeError('Network request failed'); },
    });
    await expect(http.get('/x')).rejects.toBeInstanceOf(NetworkError);
  });

  it('un timeout se distingue de un fallo de conexión', async () => {
    const http = new HttpClient({
      baseUrl: 'http://x',
      fetchImpl: async () => {
        const err = new Error('timed out');
        err.name = 'TimeoutError';
        throw err;
      },
    });
    await expect(http.get('/x')).rejects.toThrow(/no respondió en tiempo/);
  });

  it('los 5xx y el 429 son reintentables; los otros 4xx no', async () => {
    const build = async (status: number): Promise<ApiError> => {
      const http = new HttpClient({ baseUrl: 'http://x', fetchImpl: stub(status, { error: { code: 'x', message: 'y' } }) });
      return capture(http.get('/x'));
    };
    expect((await build(503)).retryable).toBe(true);
    expect((await build(429)).retryable).toBe(true);
    expect((await build(409)).retryable).toBe(false);
    expect((await build(400)).retryable).toBe(false);
  });

  it('el mensaje para humanos distingue los casos que le importan al usuario', () => {
    expect(humanMessage(new NetworkError('x'))).toMatch(/conexión/);
    expect(humanMessage(new UnauthenticatedError(401, 'a', 'b'))).toMatch(/sesión/);
    expect(humanMessage(new QuoteExpiredError(410, 'a', 'b'))).toMatch(/precio/);
    expect(humanMessage(new Error('interno'))).not.toMatch(/interno/);
  });
});

describe('generateId', () => {
  it('no repite', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateId()));
    expect(ids.size).toBe(500);
  });

  it('funciona sin crypto.randomUUID, como en React Native', () => {
    const original = globalThis.crypto;
    // @ts-expect-error se borra a propósito para simular React Native
    delete globalThis.crypto;
    try {
      const ids = new Set(Array.from({ length: 500 }, () => generateId()));
      expect(ids.size).toBe(500);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
