/**
 * Transporte HTTP.
 *
 * Sin dependencias: usa el `fetch` global, que existe en React Native y en Node
 * 18+. Se puede inyectar otro para los tests.
 */

import { buildApiError, NetworkError, type ApiError } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Devuelve el token o null. Se llama en cada request, no se cachea. */
  readonly getToken?: () => Promise<string | null>;
  /** Se llama cuando el servidor responde 401, para que la app vuelva al login. */
  readonly onUnauthenticated?: () => void;
}

interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly auth?: boolean;
  /**
   * Clave de idempotencia. La red móvil duplica requests, y "aceptar viaje"
   * apretado dos veces no puede producir dos efectos.
   */
  readonly idempotencyKey?: string;
  readonly timeoutMs?: number;
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    requestId?: string;
  };
}

/**
 * Identificador para claves de idempotencia.
 *
 * No necesita ser criptográfico: necesita ser único. Usa `crypto.randomUUID`
 * cuando existe —Node y navegadores modernos— y cae a una combinación de
 * timestamp y aleatorio cuando no, que es el caso de React Native sin polyfill.
 * El timestamp evita colisiones entre reintentos del mismo dispositivo, que es
 * el escenario que importa.
 */
export function generateId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpOptions) {
    // Sin barra final: todas las rutas empiezan con '/', y '//v1/quotes' es un
    // 404 silencioso que cuesta media hora encontrar.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  get url(): string {
    return this.baseUrl;
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };

    // Content-Type solo si hay body. Declarar JSON sin mandar nada es
    // contradictorio y un servidor estricto tiene razón en rechazarlo.
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    if (options.auth !== false && this.options.getToken) {
      const token = await this.options.getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.method !== 'GET') {
      headers['Idempotency-Key'] = options.idempotencyKey ?? generateId();
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${options.path}`, {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    } catch (cause) {
      const name = (cause as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new NetworkError('El servidor no respondió en tiempo.', cause);
      }
      throw new NetworkError('No se pudo conectar con el servidor.', cause);
    }

    const text = await response.text();

    if (!response.ok) {
      throw this.toError(response.status, text);
    }

    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NetworkError('El servidor devolvió una respuesta ilegible.');
    }
  }

  private toError(status: number, text: string): ApiError {
    let envelope: ErrorEnvelope = {};
    try {
      envelope = JSON.parse(text) as ErrorEnvelope;
    } catch {
      // El servidor puede devolver HTML en un 502 de un proxy.
    }
    const code = envelope.error?.code ?? `http_${status}`;
    const message = envelope.error?.message ?? `El servidor respondió ${status}.`;
    const error = buildApiError(status, code, message, envelope.error?.details, envelope.error?.requestId);

    if (status === 401) this.options.onUnauthenticated?.();
    return error;
  }

  get<T>(path: string, auth = true): Promise<T> {
    return this.request<T>({ method: 'GET', path, auth });
  }

  post<T>(path: string, body?: unknown, opts: { auth?: boolean; idempotencyKey?: string } = {}): Promise<T> {
    return this.request<T>({
      method: 'POST',
      path,
      ...(body === undefined ? {} : { body }),
      ...(opts.auth === undefined ? {} : { auth: opts.auth }),
      ...(opts.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
    });
  }
}
