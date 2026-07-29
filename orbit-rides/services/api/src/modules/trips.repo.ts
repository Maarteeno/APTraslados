import type { Queryable } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import type { Actor, CurrencyCode, TripStatus } from '@orbit/domain';

export interface TripRow {
  id: string;
  city_id: string;
  rider_id: string;
  driver_id: string | null;
  vehicle_id: string | null;
  quote_id: string;
  status: TripStatus;
  origin_lat: number;
  origin_lng: number;
  origin_address: string | null;
  destination_lat: number;
  destination_lng: number;
  destination_address: string | null;
  fare_cents: string | null;
  currency: CurrencyCode;
  commission_bps: number | null;
  commission_cents: string | null;
  driver_earnings_cents: string | null;
  payment_method: 'cash' | 'card' | 'wallet';
  cancellation_fee_cents: string;
  canceled_by: Actor | null;
  cancel_reason: string | null;
  /** Trazado origen→destino en polyline6. Copiado de la cotización. */
  route_polyline: string | null;
  /** Trazado conductor→origen en polyline6. Se calcula al aceptar. */
  pickup_polyline: string | null;
  /** Maniobras del viaje. JSONB, ya parseado por pg. */
  route_steps: unknown;
  /** Maniobras hacia el origen. */
  pickup_steps: unknown;
  requested_at: Date;
  accepted_at: Date | null;
  arrived_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
}

const SELECT_TRIP = `
  SELECT id, city_id, rider_id, driver_id, vehicle_id, quote_id, status,
         ST_Y(origin::geometry)      AS origin_lat,
         ST_X(origin::geometry)      AS origin_lng,
         origin_address,
         ST_Y(destination::geometry) AS destination_lat,
         ST_X(destination::geometry) AS destination_lng,
         destination_address,
         fare_cents, currency, commission_bps, commission_cents, driver_earnings_cents,
         payment_method, cancellation_fee_cents, canceled_by, cancel_reason,
         route_polyline, pickup_polyline, route_steps, pickup_steps,
         requested_at, accepted_at, arrived_at, started_at, completed_at
    FROM trips`;

export async function getTrip(tx: Queryable, tripId: string): Promise<TripRow> {
  const { rows } = await tx.query<TripRow>(`${SELECT_TRIP} WHERE id = $1`, [tripId]);
  const trip = rows[0];
  if (!trip) throw new NotFoundError('viaje');
  return trip;
}

/** Bloquea la fila para evitar transiciones concurrentes sobre el mismo viaje. */
export async function getTripForUpdate(tx: Queryable, tripId: string): Promise<TripRow> {
  const { rows } = await tx.query<TripRow>(`${SELECT_TRIP} WHERE id = $1 FOR UPDATE`, [tripId]);
  const trip = rows[0];
  if (!trip) throw new NotFoundError('viaje');
  return trip;
}

export interface CreateTripInput {
  readonly cityId: string;
  readonly riderId: string;
  readonly quoteId: string;
  readonly origin: { lat: number; lng: number };
  readonly originAddress: string | null;
  readonly destination: { lat: number; lng: number };
  readonly destinationAddress: string | null;
  readonly currency: CurrencyCode;
  readonly paymentMethod: 'cash' | 'card' | 'wallet';
  readonly quotedRoute: unknown;
  /**
   * Trazado de la cotización, en polyline6.
   *
   * Se COPIA en vez de leerse por join contra quotes: el viaje es el registro
   * histórico, y si algún día se purgan cotizaciones viejas por retención de
   * datos, el viaje tiene que seguir sabiendo qué camino se recorrió.
   */
  readonly routePolyline: string | null;
  readonly routeSteps: unknown;
}

export async function createTrip(tx: Queryable, input: CreateTripInput): Promise<string> {
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO trips (city_id, rider_id, quote_id, status,
                          origin, origin_address, destination, destination_address,
                          currency, payment_method, quoted_route, route_polyline, route_steps)
       VALUES ($1, $2, $3, 'REQUESTED',
               ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6,
               ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography, $9,
               $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        input.cityId, input.riderId, input.quoteId,
        input.origin.lng, input.origin.lat, input.originAddress,
        input.destination.lng, input.destination.lat, input.destinationAddress,
        input.currency, input.paymentMethod, JSON.stringify(input.quotedRoute),
        input.routePolyline, JSON.stringify(input.routeSteps ?? []),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('el INSERT de trips no devolvió id');
    return row.id;
  } catch (err) {
    // trips_one_open_per_rider: el índice parcial único de la migración 0004.
    if (isUniqueViolation(err, 'trips_one_open_per_rider')) {
      throw new ConflictError('ya tenés un viaje en curso');
    }
    throw err;
  }
}

export async function appendEvent(
  tx: Queryable,
  tripId: string,
  fromStatus: TripStatus | null,
  toStatus: TripStatus,
  actor: Actor,
  actorId: string | null,
  payload: unknown = null,
): Promise<void> {
  await tx.query(
    `INSERT INTO trip_events (trip_id, from_status, to_status, actor, actor_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tripId, fromStatus, toStatus, actor, actorId, payload === null ? null : JSON.stringify(payload)],
  );
}

/**
 * Cambia el estado con guarda optimista: el UPDATE exige el estado anterior.
 * Si otro request ya transicionó el viaje, rowCount es 0 y devolvemos 409 en
 * vez de sobreescribir en silencio.
 */
export async function updateStatus(
  tx: Queryable,
  tripId: string,
  expectedFrom: TripStatus,
  to: TripStatus,
  extraSetSql = '',
  extraParams: readonly unknown[] = [],
): Promise<void> {
  const sql =
    `UPDATE trips SET status = $3, updated_at = now()${extraSetSql ? `, ${extraSetSql}` : ''}
      WHERE id = $1 AND status = $2`;
  const { rowCount } = await tx.query(sql, [tripId, expectedFrom, to, ...extraParams]);
  if (rowCount === 0) {
    throw new ConflictError(`el viaje ya no está en ${expectedFrom}: alguien lo cambió primero`);
  }
}

export interface AssignDriverInput {
  readonly tripId: string;
  readonly driverId: string;
  readonly vehicleId: string | null;
  readonly commissionBps: number;
}

/**
 * Asigna conductor y CONGELA la comisión.
 *
 * El congelamiento es lo importante: si el conductor cambia de plan mientras
 * viaja, la comisión de este viaje no se mueve. Sin eso, la liquidación no se
 * puede defender frente a una disputa.
 */
export async function assignDriver(tx: Queryable, input: AssignDriverInput): Promise<void> {
  try {
    const { rowCount } = await tx.query(
      `UPDATE trips
          SET status = 'ACCEPTED',
              driver_id = $2,
              vehicle_id = $3,
              commission_bps = $4,
              accepted_at = now(),
              updated_at = now()
        WHERE id = $1 AND status = 'MATCHING' AND driver_id IS NULL`,
      [input.tripId, input.driverId, input.vehicleId, input.commissionBps],
    );
    if (rowCount === 0) {
      throw new ConflictError('el viaje ya fue tomado por otro conductor o dejó de estar disponible');
    }
  } catch (err) {
    if (isUniqueViolation(err, 'trips_one_active_per_driver')) {
      throw new ConflictError('ya tenés un viaje activo');
    }
    throw err;
  }
}

/**
 * Guarda el trazado del conductor hacia el origen.
 *
 * Va fuera de la transacción de aceptación a propósito: pedirle una ruta a OSRM
 * dentro de la transacción que asigna el viaje mantendría abierto un `FOR
 * UPDATE` sobre la fila durante una llamada de red. Un OSRM lento bloquearía a
 * cualquiera que toque ese viaje. El trazado es cosmético; la asignación no.
 */
export async function setPickupRoute(
  tx: Queryable, tripId: string, polyline: string | null, steps: unknown,
): Promise<void> {
  await tx.query(
    `UPDATE trips SET pickup_polyline = $2, pickup_steps = $3, updated_at = now() WHERE id = $1`,
    [tripId, polyline, JSON.stringify(steps ?? [])],
  );
}

export async function recordOffers(
  tx: Queryable,
  tripId: string,
  wave: number,
  expiresAt: Date,
  offers: ReadonlyArray<{ driverId: string; etaSeconds: number; distanceMeters: number; score: number }>,
): Promise<void> {
  for (const o of offers) {
    await tx.query(
      `INSERT INTO trip_offers (trip_id, driver_id, wave, eta_seconds, distance_meters, score, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (trip_id, driver_id) DO NOTHING`,
      [tripId, o.driverId, wave, o.etaSeconds, Math.round(o.distanceMeters), o.score.toFixed(4), expiresAt],
    );
  }
}

export async function resolveOffer(
  tx: Queryable,
  tripId: string,
  driverId: string,
  outcome: 'accepted' | 'rejected' | 'timeout' | 'superseded',
): Promise<void> {
  await tx.query(
    `UPDATE trip_offers SET outcome = $3, decided_at = now()
      WHERE trip_id = $1 AND driver_id = $2 AND outcome IS NULL`,
    [tripId, driverId, outcome],
  );
}

export async function expireOpenOffers(tx: Queryable, tripId: string): Promise<string[]> {
  const { rows } = await tx.query<{ driver_id: string }>(
    `UPDATE trip_offers SET outcome = 'timeout', decided_at = now()
      WHERE trip_id = $1 AND outcome IS NULL
      RETURNING driver_id`,
    [tripId],
  );
  return rows.map((r) => r.driver_id);
}

export async function listOfferedDriverIds(tx: Queryable, tripId: string): Promise<string[]> {
  const { rows } = await tx.query<{ driver_id: string }>(
    `SELECT driver_id FROM trip_offers WHERE trip_id = $1`,
    [tripId],
  );
  return rows.map((r) => r.driver_id);
}

export async function listEvents(tx: Queryable, tripId: string): Promise<Array<{
  from_status: TripStatus | null; to_status: TripStatus; actor: Actor; at: Date; payload: unknown;
}>> {
  const { rows } = await tx.query<{
    from_status: TripStatus | null; to_status: TripStatus; actor: Actor; at: Date; payload: unknown;
  }>(
    `SELECT from_status, to_status, actor, at, payload
       FROM trip_events WHERE trip_id = $1 ORDER BY id ASC`,
    [tripId],
  );
  return rows;
}

/**
 * Viaje abierto del usuario, sea pasajero o conductor.
 *
 * La app lo consulta al arrancar: si el usuario cerró la app a mitad de un
 * viaje, tiene que volver a la pantalla del viaje, no al mapa vacío.
 */
export async function findActiveTripForUser(tx: Queryable, userId: string): Promise<TripRow | null> {
  const { rows } = await tx.query<TripRow>(
    `${SELECT_TRIP}
      WHERE (rider_id = $1 OR driver_id = $1)
        AND status IN ('REQUESTED','MATCHING','ACCEPTED','ARRIVED','IN_PROGRESS')
      ORDER BY requested_at DESC
      LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function findOpenOfferForDriver(
  tx: Queryable,
  driverId: string,
): Promise<{ trip_id: string; expires_at: Date } | null> {
  const { rows } = await tx.query<{ trip_id: string; expires_at: Date }>(
    `SELECT trip_id, expires_at
       FROM trip_offers
      WHERE driver_id = $1 AND outcome IS NULL AND expires_at > now()
      ORDER BY sent_at DESC LIMIT 1`,
    [driverId],
  );
  return rows[0] ?? null;
}

/**
 * Detecta violación de un índice único concreto.
 *
 * 23505 = unique_violation en PostgreSQL. Se compara el nombre del constraint
 * para no confundir "ya tenés un viaje abierto" con cualquier otra colisión:
 * son mensajes distintos para el usuario.
 */
interface PgError {
  readonly code?: string;
  readonly constraint?: string;
}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, constraint: violated } = err as PgError;
  return code === UNIQUE_VIOLATION && violated === constraint;
}
