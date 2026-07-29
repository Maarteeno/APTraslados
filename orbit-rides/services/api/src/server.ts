import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { loadConfig } from './config/index.js';
import { BadRequestError } from './lib/errors.js';
import { loggerOptions } from './lib/logger.js';
import { registerAuth } from './auth/plugin.js';
import { registerErrorHandler } from './http/plugin.js';
import { registerRoutes } from './http/routes.js';
import { registerWebSockets } from './ws/routes.js';

export async function buildServer(): Promise<FastifyInstance> {
  const config = loadConfig();

  const app = Fastify({
    logger: loggerOptions,
    trustProxy: true,
    bodyLimit: 256 * 1024,
    requestIdHeader: 'x-request-id',
  });

  /**
   * Body vacío con Content-Type: application/json.
   *
   * Varios endpoints no llevan body (`/accept`, `/arrived`, `/start`,
   * `/reject`), pero casi todo cliente HTTP manda igual la cabecera
   * Content-Type. Fastify por defecto responde
   * "Body cannot be empty when content-type is set to 'application/json'".
   *
   * Exigirle al cliente que omita una cabecera para no recibir un error es
   * hostil y una fuente garantizada de bugs en las apps móviles. Un body vacío
   * se trata como `{}` y la validación de zod decide después.
   */
  app.addContentTypeParser<string>(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const raw = typeof body === 'string' ? body.trim() : '';
      if (raw.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch {
        done(new BadRequestError('el body no es JSON válido'), undefined);
      }
    },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS === '*' ? true : config.CORS_ORIGINS.split(','),
    credentials: true,
  });

  // Límite global. Los endpoints sensibles deberían tener límites propios más
  // estrictos; esto es el piso, no el techo.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.headers.authorization ?? request.ip,
  });

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  registerErrorHandler(app);
  await registerAuth(app);
  await registerRoutes(app);
  await registerWebSockets(app);

  return app;
}
