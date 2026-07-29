/**
 * Errores del cliente.
 *
 * El API responde siempre con el mismo envoltorio:
 *
 *   { "error": { "code": "...", "message": "...", "details": ..., "requestId": "..." } }
 *
 * Acá se traduce a clases que la UI puede distinguir. Eso importa: "tu token
 * venció" y "no hay conductores" son dos cosas muy distintas para el usuario, y
 * si la app solo tiene un `catch` genérico, las dos terminan en el mismo cartel
 * inútil de "algo salió mal".
 */

export class OrbitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** El servidor respondió con un error. */
export class ApiError extends OrbitError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }

  /** ¿Conviene reintentar? Los 5xx sí; los 4xx casi nunca. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

/** No se pudo llegar al servidor: sin red, DNS, timeout, host equivocado. */
export class NetworkError extends OrbitError {
  // `override` porque Error ya define `cause` desde ES2022. Sin el modificador
  // TypeScript estricto lo rechaza, y con razón: pisar un miembro de la clase
  // base sin decirlo es la clase de cosa que rompe en una actualización.
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
  }
}

/** La sesión no sirve. La app tiene que volver al login. */
export class UnauthenticatedError extends ApiError {}

/** El token es válido pero el rol no alcanza. */
export class ForbiddenError extends ApiError {}

/** Conflicto de estado: el viaje ya lo tomó otro, la cotización ya se usó. */
export class ConflictError extends ApiError {}

/** La cotización venció. Hay que pedir una nueva. */
export class QuoteExpiredError extends ApiError {}

/** Construye la clase correcta a partir del status y el código del servidor. */
export function buildApiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
  requestId?: string,
): ApiError {
  const args = [status, code, message, details, requestId] as const;
  if (status === 401) return new UnauthenticatedError(...args);
  if (status === 403) return new ForbiddenError(...args);
  if (status === 409) return new ConflictError(...args);
  if (status === 410 || code === 'quote_expired') return new QuoteExpiredError(...args);
  return new ApiError(...args);
}

/** Mensaje para mostrarle a una persona, no para el log. */
export function humanMessage(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'No podemos conectarnos. Revisá tu conexión.';
  }
  if (error instanceof UnauthenticatedError) {
    return 'Tu sesión venció. Volvé a entrar.';
  }
  if (error instanceof ForbiddenError) {
    return 'No tenés permiso para esta acción.';
  }
  if (error instanceof QuoteExpiredError) {
    return 'El precio venció. Pedí una cotización nueva.';
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  return 'Algo no funcionó. Probá de nuevo.';
}
