/**
 * Worker de dispatch.
 *
 * Corre las olas en background con timers. Es deliberadamente simple: una cola
 * en memoria por proceso.
 *
 * LÍMITE CONOCIDO Y ASUMIDO: con más de una instancia del API, dos procesos
 * podrían despachar el mismo viaje. La protección real está en la base (el
 * índice único `trips_one_active_per_driver` y el UPDATE condicional de
 * `assignDriver`), así que el peor caso es trabajo duplicado, no un viaje
 * doblemente asignado. Cuando escales a varias instancias, esto se reemplaza
 * por BullMQ sobre Redis: ver infra/k8s/README.
 */

import { loadConfig } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { markNoDrivers, runWave, timeoutWave } from '../modules/dispatch.service.js';
import { startMatching } from '../modules/trips.service.js';

const pending = new Map<string, NodeJS.Timeout>();

function clear(tripId: string): void {
  const timer = pending.get(tripId);
  if (timer) {
    clearTimeout(timer);
    pending.delete(tripId);
  }
}

async function runWaveChain(tripId: string, waveNumber: number): Promise<void> {
  const config = loadConfig();
  const maxWaves = config.DISPATCH_WAVE_RADII_M.length;

  if (waveNumber > maxWaves) {
    await markNoDrivers(tripId);
    clear(tripId);
    return;
  }

  let result;
  try {
    result = await runWave(tripId, waveNumber);
  } catch (err) {
    logger.error({ err, tripId, waveNumber }, 'falló la ola de dispatch');
    await markNoDrivers(tripId).catch((e) => logger.error({ err: e, tripId }, 'tampoco se pudo marcar NO_DRIVERS'));
    clear(tripId);
    return;
  }

  if (result.kind === 'no_drivers') {
    // No había nadie en este radio: se intenta el siguiente sin esperar el TTL.
    if (waveNumber >= maxWaves) {
      await markNoDrivers(tripId);
      clear(tripId);
      return;
    }
    void runWaveChain(tripId, waveNumber + 1);
    return;
  }

  // Se enviaron ofertas: esperar el TTL y, si nadie aceptó, pasar a la siguiente ola.
  const timer = setTimeout(() => {
    void (async () => {
      try {
        await timeoutWave(tripId, result.offeredDriverIds);
        await runWaveChain(tripId, waveNumber + 1);
      } catch (err) {
        logger.error({ err, tripId }, 'falló el vencimiento de la ola');
        clear(tripId);
      }
    })();
  }, config.DISPATCH_OFFER_TTL_SECONDS * 1000 + 500);

  pending.set(tripId, timer);
}

/** Arranca el dispatch de un viaje recién creado. */
export function enqueueTrip(tripId: string): void {
  void (async () => {
    try {
      await startMatching(tripId);
      await runWaveChain(tripId, 1);
    } catch (err) {
      logger.error({ err, tripId }, 'no se pudo iniciar el dispatch');
    }
  })();
}

/** El conductor aceptó: se corta la cadena de olas. */
export function cancelDispatch(tripId: string): void {
  clear(tripId);
}

export function pendingCount(): number {
  return pending.size;
}

export function shutdownDispatcher(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
