import { createRequire } from 'node:module';
import pino, { type LoggerOptions } from 'pino';
import { loadConfig } from '../config/index.js';

const config = loadConfig();

/**
 * ¿Está pino-pretty disponible?
 *
 * pino-pretty es una devDependency: no viaja en la imagen de producción. Si
 * LOG_PRETTY=true pero el módulo no está, se degrada a JSON con un aviso en
 * vez de tirar el proceso.
 *
 * El bug que esto evita: el servicio arrancaba con transport pino-pretty
 * cuando NODE_ENV !== 'production', y como docker-compose pone
 * NODE_ENV=development sobre una imagen construida con `npm ci --omit=dev`,
 * el contenedor entraba en loop de reinicio con
 * "unable to determine transport target for pino-pretty".
 */
function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const wantsPretty = config.LOG_PRETTY;
const canPretty = wantsPretty && prettyAvailable();

if (wantsPretty && !canPretty) {
  // console porque el logger todavía no existe.
  console.warn(
    '[logger] LOG_PRETTY=true pero pino-pretty no está instalado ' +
      '(es una devDependency). Se usan logs en JSON.',
  );
}

/**
 * Opciones compartidas.
 *
 * Fastify recibe las OPCIONES, no una instancia ya construida: si se le pasa
 * una instancia concreta de pino, el tipo del logger se fija a `Logger<never>`
 * y deja de ser compatible con `FastifyBaseLogger`, que es lo que esperan los
 * plugins. Pasando opciones, Fastify arma el suyo y los tipos cierran solos.
 */
export const loggerOptions: LoggerOptions = {
  level: config.LOG_LEVEL,
  ...(canPretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
  redact: {
    // Nunca loguear credenciales ni datos personales completos.
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.phone_e164',
      '*.phoneE164',
      '*.signature',
      '*.token',
    ],
    censor: '[oculto]',
  },
};

/** Logger para lo que corre fuera de un request: workers, scripts, arranque. */
export const logger = pino(loggerOptions);
