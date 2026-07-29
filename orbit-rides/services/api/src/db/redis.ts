/**
 * Redis: posiciones de conductor en vivo y locks de dispatch.
 *
 * Las posiciones NO van a Postgres. A 1 escritura cada 4 segundos por
 * conductor, 200 conductores son ~4,3 millones de escrituras por día y el
 * autovacuum no da. Acá viven con TTL: si un conductor deja de reportar, se
 * cae solo del índice y deja de recibir ofertas.
 */

import { Redis } from 'ioredis';
import { loadConfig } from '../config/index.js';
import { logger } from '../lib/logger.js';
import type { LatLng } from '@orbit/domain';

const config = loadConfig();

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  enableReadyCheck: true,
});

redis.on('error', (err) => logger.error({ err }, 'error de Redis'));

const geoKey = (cityId: string) => `drivers:online:${cityId}`;
const posKey = (driverId: string) => `driver:pos:${driverId}`;
const lockKey = (driverId: string) => `driver:lock:${driverId}`;
const offerKey = (tripId: string, driverId: string) => `offer:${tripId}:${driverId}`;

export interface DriverPosition {
  readonly lat: number;
  readonly lng: number;
  readonly bearing: number | null;
  readonly at: number;
}

/** Reporta la posición del conductor. El TTL hace que la ausencia sea auto-limpiable. */
export async function setDriverPosition(
  cityId: string,
  driverId: string,
  position: LatLng,
  bearing: number | null,
): Promise<void> {
  const payload: DriverPosition = { lat: position.lat, lng: position.lng, bearing, at: Date.now() };
  await redis
    .multi()
    .geoadd(geoKey(cityId), position.lng, position.lat, driverId)
    .set(posKey(driverId), JSON.stringify(payload), 'EX', config.DRIVER_POSITION_TTL_SECONDS)
    .exec();
}

export async function getDriverPosition(driverId: string): Promise<DriverPosition | null> {
  const raw = await redis.get(posKey(driverId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DriverPosition;
  } catch {
    return null;
  }
}

export async function removeDriverFromIndex(cityId: string, driverId: string): Promise<void> {
  await redis.multi().zrem(geoKey(cityId), driverId).del(posKey(driverId)).exec();
}

export interface NearbyDriver {
  readonly driverId: string;
  readonly distanceMeters: number;
  readonly lat: number;
  readonly lng: number;
}

/**
 * Conductores dentro del radio, ordenados por cercanía.
 *
 * Filtra los que están en el índice geo pero cuya posición ya venció: el
 * GEOADD no tiene TTL por miembro, así que el `driver:pos:*` con EX es la
 * fuente de verdad sobre "sigue reportando".
 */
export async function findNearbyDrivers(
  cityId: string,
  origin: LatLng,
  radiusMeters: number,
  limit = 50,
): Promise<NearbyDriver[]> {
  const raw = (await redis.georadius(
    geoKey(cityId),
    origin.lng,
    origin.lat,
    radiusMeters,
    'm',
    'WITHDIST',
    'WITHCOORD',
    'ASC',
    'COUNT',
    limit,
  )) as unknown as Array<[string, string, [string, string]]>;

  const results: NearbyDriver[] = [];
  const stale: string[] = [];

  for (const entry of raw) {
    const driverId = entry[0];
    const fresh = await redis.exists(posKey(driverId));
    if (!fresh) {
      stale.push(driverId);
      continue;
    }
    results.push({
      driverId,
      distanceMeters: Number(entry[1]),
      lng: Number(entry[2][0]),
      lat: Number(entry[2][1]),
    });
  }
  if (stale.length > 0) {
    await redis.zrem(geoKey(cityId), ...stale);
  }
  return results;
}

/**
 * Lock de asignación. Sin esto, dos viajes simultáneos ofertan al mismo
 * conductor y uno queda huérfano: el clásico error del dispatch casero.
 *
 * SET NX + EX es atómico. El TTL garantiza que un worker que muere no deje el
 * lock tomado para siempre.
 */
export async function acquireDriverLock(driverId: string, ttlSeconds: number): Promise<boolean> {
  const res = await redis.set(lockKey(driverId), '1', 'EX', ttlSeconds, 'NX');
  return res === 'OK';
}

export async function releaseDriverLock(driverId: string): Promise<void> {
  await redis.del(lockKey(driverId));
}

export async function isDriverLocked(driverId: string): Promise<boolean> {
  return (await redis.exists(lockKey(driverId))) === 1;
}

/** Marca la oferta como abierta con TTL, para saber si venció sin consultar la base. */
export async function markOfferOpen(tripId: string, driverId: string, ttlSeconds: number): Promise<void> {
  await redis.set(offerKey(tripId, driverId), '1', 'EX', ttlSeconds);
}

export async function isOfferOpen(tripId: string, driverId: string): Promise<boolean> {
  return (await redis.exists(offerKey(tripId, driverId))) === 1;
}

export async function closeOffer(tripId: string, driverId: string): Promise<void> {
  await redis.del(offerKey(tripId, driverId));
}

export async function redisHealthcheck(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
