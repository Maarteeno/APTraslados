/**
 * Punto de entrada.
 *
 * Apagado ordenado: se deja de aceptar conexiones, se cortan los timers de
 * dispatch y se cierran los pools. Sin esto, un despliegue corta viajes a la
 * mitad y deja locks de Redis tomados hasta que expira el TTL.
 */

import { loadConfig } from './config/index.js';
import { buildServer } from './server.js';
import { logger } from './lib/logger.js';
import { closePool } from './db/pool.js';
import { closeRedis } from './db/redis.js';
import { shutdownDispatcher } from './workers/dispatcher.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer();

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info(
    { port: config.PORT, authMode: config.AUTH_MODE, env: config.NODE_ENV },
    'Orbit Rides API arriba',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'apagando ordenadamente');
    shutdownDispatcher();
    try {
      await app.close();
      await closePool();
      await closeRedis();
      logger.info('apagado completo');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'falló el apagado ordenado');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'promesa rechazada sin manejar');
  });
}

main().catch((err: unknown) => {
  logger.error({ err }, 'no se pudo arrancar el API');
  process.exit(1);
});
