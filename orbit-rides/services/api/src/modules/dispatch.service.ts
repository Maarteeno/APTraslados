/**
 * Dispatch: ejecuta las olas de ofertas.
 *
 * La decisión de A QUIÉN ofertar vive en @orbit/domain (pura y testeada).
 * Acá está solo el I/O: buscar en Redis, cruzar con Postgres, tomar locks,
 * escribir ofertas, notificar por WebSocket y programar el vencimiento.
 */

import {
  planWave, DEFAULT_DISPATCH_CONFIG, type DispatchConfig,
  type DriverCandidate, type LatLng, type Wave,
} from '@orbit/domain';
import { loadConfig } from '../config/index.js';
import { withTransaction, type Queryable } from '../db/pool.js';
import { findNearbyDrivers, acquireDriverLock, releaseDriverLock, markOfferOpen, closeOffer } from '../db/redis.js';
import { logger } from '../lib/logger.js';
import { loadEligibility, toCandidate } from './drivers.repo.js';
import {
  expireOpenOffers, getTrip, listOfferedDriverIds, recordOffers, updateStatus, appendEvent,
} from './trips.repo.js';
import { publish } from '../ws/hub.js';

export function buildDispatchConfig(): DispatchConfig {
  const config = loadConfig();
  return {
    ...DEFAULT_DISPATCH_CONFIG,
    waveRadiiMeters: config.DISPATCH_WAVE_RADII_M,
    waveSizes: config.DISPATCH_WAVE_SIZES,
    offerTtlSeconds: config.DISPATCH_OFFER_TTL_SECONDS,
  };
}

async function gatherCandidates(
  tx: Queryable,
  cityId: string,
  origin: LatLng,
  radiusMeters: number,
  requiredCategory: string,
): Promise<DriverCandidate[]> {
  const nearby = await findNearbyDrivers(cityId, origin, radiusMeters, 60);
  if (nearby.length === 0) return [];

  const eligibility = await loadEligibility(tx, nearby.map((n) => n.driverId));
  const candidates: DriverCandidate[] = [];
  for (const n of nearby) {
    const row = eligibility.get(n.driverId);
    if (!row) continue;
    candidates.push(
      toCandidate({ driverId: n.driverId, lat: n.lat, lng: n.lng, idleMinutes: 0 }, row, requiredCategory),
    );
  }
  return candidates;
}

export interface WaveResult {
  readonly kind: 'offers_sent' | 'no_drivers';
  readonly wave: number;
  readonly offeredDriverIds: readonly string[];
}

/**
 * Corre una ola. Devuelve no_drivers cuando se agotan las olas o no hay nadie
 * elegible: eso lo traduce el worker al estado NO_DRIVERS del viaje.
 */
export async function runWave(tripId: string, waveNumber: number): Promise<WaveResult> {
  const config = buildDispatchConfig();

  const plan = await withTransaction(async (tx) => {
    const trip = await getTrip(tx, tripId);
    if (trip.status !== 'MATCHING') {
      logger.info({ tripId, status: trip.status }, 'la ola se descarta: el viaje ya no está en MATCHING');
      return null;
    }
    const origin: LatLng = { lat: trip.origin_lat, lng: trip.origin_lng };
    const radiusIndex = Math.min(waveNumber, config.waveRadiiMeters.length) - 1;
    const radius = config.waveRadiiMeters[radiusIndex] ?? 3000;

    const candidates = await gatherCandidates(tx, trip.city_id, origin, radius, config.requiredCategory);
    const alreadyOffered = new Set(await listOfferedDriverIds(tx, tripId));
    const wave: Wave | null = planWave(waveNumber, candidates, origin, config, alreadyOffered);
    return { trip, wave, origin };
  });

  if (!plan) return { kind: 'no_drivers', wave: waveNumber, offeredDriverIds: [] };
  if (!plan.wave) return { kind: 'no_drivers', wave: waveNumber, offeredDriverIds: [] };

  // Los locks se toman FUERA de la transacción de base: son de Redis y su
  // liberación no puede depender de un rollback de Postgres.
  const locked: string[] = [];
  for (const offer of plan.wave.offers) {
    const got = await acquireDriverLock(offer.candidate.driverId, config.offerTtlSeconds + 5);
    if (got) locked.push(offer.candidate.driverId);
  }
  if (locked.length === 0) {
    logger.info({ tripId, wave: waveNumber }, 'ningún conductor quedó libre al tomar el lock');
    return { kind: 'no_drivers', wave: waveNumber, offeredDriverIds: [] };
  }

  const accepted = plan.wave.offers.filter((o) => locked.includes(o.candidate.driverId));
  const expiresAt = new Date(Date.now() + config.offerTtlSeconds * 1000);

  await withTransaction(async (tx) => {
    await recordOffers(
      tx, tripId, waveNumber, expiresAt,
      accepted.map((o) => ({
        driverId: o.candidate.driverId,
        etaSeconds: o.etaSeconds,
        distanceMeters: o.distanceMeters,
        score: o.score,
      })),
    );
  });

  for (const offer of accepted) {
    await markOfferOpen(tripId, offer.candidate.driverId, config.offerTtlSeconds);
    publish('driver', offer.candidate.driverId, 'trip.offer', {
      tripId,
      wave: waveNumber,
      etaSeconds: offer.etaSeconds,
      distanceMeters: Math.round(offer.distanceMeters),
      expiresInSeconds: config.offerTtlSeconds,
      expiresAt: expiresAt.toISOString(),
    });
  }

  publish('trip', tripId, 'trip.matching', { wave: waveNumber, offersSent: accepted.length });
  logger.info({ tripId, wave: waveNumber, offers: accepted.length }, 'ola de dispatch enviada');

  return { kind: 'offers_sent', wave: waveNumber, offeredDriverIds: accepted.map((o) => o.candidate.driverId) };
}

/** Cierra las ofertas vencidas de una ola y libera los locks. */
export async function timeoutWave(tripId: string, driverIds: readonly string[]): Promise<void> {
  await withTransaction(async (tx) => {
    const timedOut = await expireOpenOffers(tx, tripId);
    logger.info({ tripId, timedOut: timedOut.length }, 'ofertas vencidas');
  });
  for (const driverId of driverIds) {
    await closeOffer(tripId, driverId);
    await releaseDriverLock(driverId);
  }
}

/** No quedaron conductores: se cierra el viaje y se avisa al pasajero. */
export async function markNoDrivers(tripId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const trip = await getTrip(tx, tripId);
    if (trip.status !== 'MATCHING' && trip.status !== 'REQUESTED') return;
    await updateStatus(tx, tripId, trip.status, 'NO_DRIVERS');
    await appendEvent(tx, tripId, trip.status, 'NO_DRIVERS', 'system', null, {
      reason: 'se agotaron las olas de dispatch sin conductores elegibles',
    });
  });
  publish('trip', tripId, 'trip.no_drivers', { tripId });
}
