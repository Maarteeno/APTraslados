/**
 * Manejo de errores y parseo validado.
 *
 * Un solo lugar traduce excepciones a respuestas HTTP. En producción no se
 * filtra el mensaje interno de un error inesperado: se loguea con un requestId
 * y al cliente se le da ese id para soporte.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import { AppError, BadRequestError } from '../lib/errors.js';
import {
  DispatchError, GeoError, LedgerError, MoneyError, PricingError,
  QuoteExpiredError, QuoteInvalidError, TripStateError, CommissionError,
} from '@orbit/domain';
import { loadConfig } from '../config/index.js';

/** Valida el body/params y devuelve el tipo. Un fallo es 400 con detalle utilizable. */
export function parse<T>(schema: ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new BadRequestError('la petición no es válida', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export function registerErrorHandler(app: FastifyInstance): void {
  const config = loadConfig();

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: { code: 'not_found', message: `no existe ${request.method} ${request.url}` },
    } satisfies ErrorBody);
  });

  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    // 1. Errores propios: ya traen status y código.
    if (error instanceof AppError) {
      const body: ErrorBody = { error: { code: error.code, message: error.message } };
      if (error.details !== undefined) body.error.details = error.details;
      return reply.status(error.statusCode).send(body);
    }

    // 2. Errores del dominio: se mapean a semántica HTTP.
    if (error instanceof QuoteExpiredError) {
      return reply.status(410).send({ error: { code: 'quote_expired', message: error.message } } satisfies ErrorBody);
    }
    if (error instanceof QuoteInvalidError) {
      return reply.status(422).send({ error: { code: 'quote_invalid', message: error.message } } satisfies ErrorBody);
    }
    if (error instanceof TripStateError) {
      return reply.status(409).send({ error: { code: 'invalid_transition', message: error.message } } satisfies ErrorBody);
    }
    if (
      error instanceof PricingError || error instanceof MoneyError ||
      error instanceof GeoError || error instanceof DispatchError ||
      error instanceof CommissionError
    ) {
      return reply.status(422).send({ error: { code: 'domain_error', message: error.message } } satisfies ErrorBody);
    }
    if (error instanceof LedgerError) {
      // Un desbalance es un bug nuestro, no del cliente. 500 y alarma.
      request.log.error({ err: error }, 'ERROR DE LEDGER: revisar de inmediato');
      return reply.status(500).send({
        error: { code: 'ledger_error', message: 'error contable', requestId: request.id },
      } satisfies ErrorBody);
    }

    // 3. Zod que se escapó de parse().
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'bad_request',
          message: 'la petición no es válida',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      } satisfies ErrorBody);
    }

    // 4. Errores de Fastify y de plugins: traen su propio statusCode.
    //
    // Sin esto, un body malformado o un content-type inválido salían como 500.
    // Eso no es cosmético: los 500 son la señal de "algo se rompió de nuestro
    // lado" y disparan alertas. Si un cliente mal escrito puede generarlos, la
    // señal se ahoga y los 500 de verdad pasan desapercibidos.
    if (typeof error === 'object' && error !== null) {
      const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
      const status = candidate.statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return reply.status(status).send({
          error: {
            code: typeof candidate.code === 'string' ? candidate.code.toLowerCase() : 'bad_request',
            message: typeof candidate.message === 'string' ? candidate.message : 'petición inválida',
          },
        } satisfies ErrorBody);
      }
    }

    // 5. Todo lo demás: es nuestro. No se filtra al cliente.
    request.log.error({ err: error }, 'error no manejado');
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: config.isProduction
          ? 'error interno; pasale este id a soporte'
          : String((error as Error)?.message ?? error),
        requestId: request.id,
      },
    } satisfies ErrorBody);
  });
}
