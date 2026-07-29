/**
 * Errores de dominio con código HTTP.
 *
 * El objetivo es que el handler global nunca tenga que adivinar: cada error
 * sabe con qué status se traduce y qué código estable ve el cliente. Los
 * mensajes internos no se filtran al cliente en producción.
 */

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) { super(400, 'bad_request', message, details); }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'credenciales inválidas o ausentes') { super(401, 'unauthorized', message); }
}
export class ForbiddenError extends AppError {
  constructor(message = 'no tenés permiso para esta operación') { super(403, 'forbidden', message); }
}
export class NotFoundError extends AppError {
  constructor(what = 'recurso') { super(404, 'not_found', `${what} no encontrado`); }
}
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) { super(409, 'conflict', message, details); }
}
export class GoneError extends AppError {
  constructor(message: string) { super(410, 'gone', message); }
}
export class UnprocessableError extends AppError {
  constructor(message: string, details?: unknown) { super(422, 'unprocessable', message, details); }
}
export class TooManyRequestsError extends AppError {
  constructor(message = 'demasiados intentos') { super(429, 'too_many_requests', message); }
}
export class ServiceUnavailableError extends AppError {
  constructor(message: string) { super(503, 'service_unavailable', message); }
}
