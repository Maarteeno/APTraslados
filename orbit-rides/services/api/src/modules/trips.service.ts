/**
 * Servicio de viajes: todas las transiciones de estado.
 *
 * Cada operación:
 *   1. bloquea la fila del viaje (FOR UPDATE),
 *   2. valida la transición con la máquina de estados del dominio,
 *   3. escribe el estado con guarda optimista,
 *   4. asienta el evento en la bitácora append-only,
 *   5. publica por WebSocket.
 *
 * El orden importa: el evento se escribe DENTRO de la misma transacción que el
 * cambio de estado. Si no, un fallo entre ambos deja un viaje sin historia.
 */

import { randomUUID } from 'node:crypto';
import {
  buildTripSettlement, computeFare, evaluateCancellation, splitFare, transition,
  verifyQuote, QuoteExpiredError, QuoteInvalidError,
  type Actor, type CurrencyCode, type SignedQuote, type TripStatus,
} from '@orbit/domain';
import { loadConfig } from '../config/index.js';
import { withTransaction, type Queryable } from '../db/pool.js';
import { closeOffer, getDriverPosition, releaseDriverLock } from '../db/redis.js';
import {
  BadRequestError, ConflictError, ForbiddenError, GoneError, UnprocessableError,
} from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { RoutingProvider } from '../lib/routing.js';
import { getActivePricing } from './cities.repo.js';
import { getDriverCommission } from './drivers.repo.js';
import { consumeQuote, getQuote } from './quotes.repo.js';
import { postTransaction } from './ledger.repo.js';
import {
  appendEvent, assignDriver, getTrip, getTripForUpdate, listEvents, resolveOffer,
  setPickupRoute, updateStatus, createTrip,
  type TripRow,
} from './trips.repo.js';
import { publish } from '../ws/hub.js';

export type PaymentMethod = 'cash' | 'card' | 'wallet';

// ───────────────────────────── Crear viaje ────────────────────────────────────

export interface RequestTripInput {
  readonly riderId: string;
  readonly quoteId: string;
  readonly paymentMethod: PaymentMethod;
}

export async function requestTrip(input: RequestTripInput): Promise<{ tripId: string; status: TripStatus }> {
  const config = loadConfig();

  return withTransaction(async (tx) => {
    const quote = await getQuote(tx, input.quoteId);

    if (quote.rider_id !== input.riderId) {
      throw new ForbiddenError('esta cotización es de otro usuario');
    }

    // Se revalida la FIRMA aunque la cotización venga de nuestra propia base:
    // protege contra una escritura directa a la base que altere el monto.
    //
    // Se verifica contra el JSON EXACTO que se firmó, no contra un payload
    // reconstruido desde las columnas. La reconstrucción era el bug: el id se
    // generaba dos veces, el surge volvía como string desde NUMERIC, y el
    // issuedAt se deducía restando el TTL de la config —que puede haber
    // cambiado entre cotizar y pedir.
    if (quote.signed_payload === null) {
      throw new UnprocessableError('esta cotización es de una versión anterior, pedí una nueva');
    }

    let signed: SignedQuote;
    try {
      signed = {
        payload: JSON.parse(quote.signed_payload) as SignedQuote['payload'],
        signature: quote.signature,
      };
    } catch {
      throw new UnprocessableError('la cotización está corrupta, pedí una nueva');
    }

    if (signed.payload.quoteId !== quote.id || signed.payload.riderId !== input.riderId) {
      throw new UnprocessableError('la cotización no corresponde a esta solicitud');
    }

    try {
      verifyQuote(signed, config.QUOTE_SIGNING_SECRET);
    } catch (err) {
      if (err instanceof QuoteExpiredError) {
        throw new GoneError('la cotización venció, pedí una nueva');
      }
      if (err instanceof QuoteInvalidError) {
        throw new UnprocessableError('la cotización no es válida');
      }
      throw err;
    }

    await consumeQuote(tx, input.quoteId);

    const tripId = await createTrip(tx, {
      cityId: quote.city_id,
      riderId: input.riderId,
      quoteId: quote.id,
      origin: { lat: quote.origin_lat, lng: quote.origin_lng },
      originAddress: quote.origin_address,
      destination: { lat: quote.destination_lat, lng: quote.destination_lng },
      destinationAddress: quote.destination_address,
      currency: quote.currency,
      paymentMethod: input.paymentMethod,
      // El trazado no está firmado, así que se toma de la columna y no del
      // payload. No hace falta protegerlo: alterarlo no cambia lo que se cobra,
      // solo dibujaría una línea equivocada.
      routePolyline: quote.route_polyline,
      routeSteps: quote.route_steps,
      quotedRoute: {
        distanceMeters: signed.payload.distanceMeters,
        durationSeconds: signed.payload.durationSeconds,
        fareCents: signed.payload.totalCents,
      },
    });

    await appendEvent(tx, tripId, null, 'REQUESTED', 'rider', input.riderId, {
      quoteId: quote.id,
      fareCents: signed.payload.totalCents,
      paymentMethod: input.paymentMethod,
    });

    return { tripId, status: 'REQUESTED' as TripStatus };
  });
}

/** REQUESTED → MATCHING. La dispara el worker, no el cliente. */
export async function startMatching(tripId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const trip = await getTripForUpdate(tx, tripId);
    transition({ from: trip.status, to: 'MATCHING', actor: 'system' });
    await updateStatus(tx, tripId, trip.status, 'MATCHING');
    await appendEvent(tx, tripId, trip.status, 'MATCHING', 'system', null, null);
  });
  publish('trip', tripId, 'trip.matching', { tripId });
}

// ───────────────────────────── Aceptar ────────────────────────────────────────

export interface AcceptTripInput {
  readonly tripId: string;
  readonly driverId: string;
  /**
   * Se inyecta igual que en createQuote, en vez de importarlo acá.
   *
   * El proveedor se arma una vez con la config en la capa HTTP; el servicio no
   * decide si hay OSRM, Mapbox o estimación local. Además así los tests pueden
   * pasar un doble sin levantar red.
   */
  readonly routing: RoutingProvider;
}

/**
 * El conductor acepta.
 *
 * Acá se congela la comisión. Y se valida que exista una oferta abierta para
 * ese conductor: sin eso, cualquier conductor podría autoasignarse los mejores
 * viajes salteando el dispatch, que es exactamente el abuso que las ofertas
 * exclusivas existen para prevenir.
 */
export async function acceptTrip(input: AcceptTripInput): Promise<{ tripId: string; commissionBps: number }> {
  const result = await withTransaction(async (tx) => {
    const trip = await getTripForUpdate(tx, input.tripId);
    transition({ from: trip.status, to: 'ACCEPTED', actor: 'system' });

    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM trip_offers
        WHERE trip_id = $1 AND driver_id = $2 AND outcome IS NULL AND expires_at > now()
        FOR UPDATE`,
      [input.tripId, input.driverId],
    );
    if (!rows[0]) {
      throw new ForbiddenError('no tenés una oferta vigente para este viaje');
    }

    const { commissionBps, vehicleId } = await getDriverCommission(tx, input.driverId, trip.city_id);

    await assignDriver(tx, {
      tripId: input.tripId,
      driverId: input.driverId,
      vehicleId,
      commissionBps,
    });
    await resolveOffer(tx, input.tripId, input.driverId, 'accepted');
    await tx.query(
      `UPDATE trip_offers SET outcome = 'superseded', decided_at = now()
        WHERE trip_id = $1 AND driver_id <> $2 AND outcome IS NULL`,
      [input.tripId, input.driverId],
    );
    await appendEvent(tx, input.tripId, trip.status, 'ACCEPTED', 'driver', input.driverId, {
      commissionBps,
      note: 'comisión congelada al aceptar',
    });

    return { tripId: input.tripId, commissionBps };
  });

  await closeOffer(input.tripId, input.driverId);
  await storePickupRoute(input.tripId, input.driverId, input.routing);
  publish('trip', input.tripId, 'trip.accepted', {
    tripId: input.tripId,
    driverId: input.driverId,
  });
  return result;
}

/**
 * Calcula y guarda el camino del conductor hacia el origen.
 *
 * Es lo que el conductor necesita ver apenas acepta: no el trayecto del viaje,
 * sino cómo llegar a buscar al pasajero.
 *
 * Best-effort, y adrede:
 *
 *  - Corre DESPUÉS de la transacción de aceptación. Meter una llamada de red
 *    dentro de la transacción que hace `FOR UPDATE` sobre el viaje significaría
 *    que un OSRM lento bloquea a todos los que toquen esa fila.
 *  - Cualquier fallo se registra y se sigue. El viaje ya está aceptado y eso es
 *    lo que importa; sin trazado la app dibuja la línea recta, que es peor pero
 *    sirve. Un proveedor de mapas caído no puede deshacer una asignación.
 */
async function storePickupRoute(
  tripId: string, driverId: string, routing: RoutingProvider,
): Promise<void> {
  try {
    const position = await getDriverPosition(driverId);
    if (!position) {
      logger.info({ tripId, driverId }, 'sin posición del conductor, no hay ruta de acercamiento');
      return;
    }
    const trip = await withTransaction((tx) => getTrip(tx, tripId));
    const route = await routing.route(
      { lat: position.lat, lng: position.lng },
      { lat: trip.origin_lat, lng: trip.origin_lng },
    );
    await withTransaction((tx) => setPickupRoute(tx, tripId, route.polyline, route.steps));
  } catch (err) {
    logger.warn({ err, tripId }, 'no se pudo calcular la ruta de acercamiento');
  }
}

export async function rejectOffer(tripId: string, driverId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await resolveOffer(tx, tripId, driverId, 'rejected');
  });
  await closeOffer(tripId, driverId);
  await releaseDriverLock(driverId);
}

// ───────────────────────────── Avance del viaje ───────────────────────────────

async function simpleTransition(
  tripId: string,
  to: Extract<TripStatus, 'ARRIVED' | 'IN_PROGRESS'>,
  actor: Actor,
  actorId: string,
  timestampColumn: 'arrived_at' | 'started_at',
): Promise<void> {
  await withTransaction(async (tx) => {
    const trip = await getTripForUpdate(tx, tripId);
    if (trip.driver_id !== actorId) {
      throw new ForbiddenError('este viaje no es tuyo');
    }
    transition({ from: trip.status, to, actor });
    await updateStatus(tx, tripId, trip.status, to, `${timestampColumn} = now()`);
    await appendEvent(tx, tripId, trip.status, to, actor, actorId, null);
  });
  publish('trip', tripId, `trip.${to.toLowerCase()}`, { tripId });
}

export const markArrived = (tripId: string, driverId: string): Promise<void> =>
  simpleTransition(tripId, 'ARRIVED', 'driver', driverId, 'arrived_at');

export const startTrip = (tripId: string, driverId: string): Promise<void> =>
  simpleTransition(tripId, 'IN_PROGRESS', 'driver', driverId, 'started_at');

// ───────────────────────────── Completar ──────────────────────────────────────

export interface CompleteTripInput {
  readonly tripId: string;
  readonly driverId: string;
  /** Distancia y duración REALES medidas por la app del conductor. */
  readonly actualDistanceMeters: number;
  readonly actualDurationSeconds: number;
}

export interface CompleteTripResult {
  readonly tripId: string;
  readonly fareCents: number;
  readonly commissionCents: number;
  readonly driverEarningsCents: number;
  readonly currency: CurrencyCode;
  readonly recalculated: boolean;
}

/**
 * Cierra el viaje y liquida.
 *
 * La tarifa final la calcula el SERVIDOR con la traza real. Se toma el máximo
 * entre lo cotizado y lo recalculado: nunca se le cobra al pasajero menos de
 * lo que aceptó, y si el recorrido real fue más largo se ajusta hacia arriba
 * con tope, para que un GPS errático no le vacíe la cuenta a nadie.
 */
export async function completeTrip(input: CompleteTripInput): Promise<CompleteTripResult> {
  const result = await withTransaction(async (tx) => {
    const trip = await getTripForUpdate(tx, input.tripId);
    if (trip.driver_id !== input.driverId) throw new ForbiddenError('este viaje no es tuyo');
    transition({ from: trip.status, to: 'COMPLETED', actor: 'driver' });
    if (trip.commission_bps === null) {
      throw new ConflictError('el viaje no tiene comisión congelada: no se puede liquidar');
    }

    const quote = await getQuote(tx, trip.quote_id);
    const quotedCents = Number(quote.fare_cents);
    const pricing = await getActivePricing(tx, trip.city_id, trip.currency);

    const recomputed = computeFare(
      { distanceMeters: input.actualDistanceMeters, durationSeconds: input.actualDurationSeconds },
      pricing,
      Number(quote.surge_multiplier),
    );

    // Tope del ajuste: 25 % sobre lo cotizado. Un salto de GPS no puede
    // convertirse en una tarifa arbitraria.
    const cap = Math.round(quotedCents * 1.25);
    const fareCents = Math.min(Math.max(quotedCents, recomputed.totalCents), cap);
    const recalculated = fareCents !== quotedCents;

    const split = splitFare(fareCents, trip.commission_bps);

    await updateStatus(
      tx, input.tripId, trip.status, 'COMPLETED',
      `completed_at = now(), fare_cents = $4, commission_cents = $5,
       driver_earnings_cents = $6, actual_route = $7`,
      [
        fareCents, split.commissionCents, split.driverEarningsCents,
        JSON.stringify({
          distanceMeters: input.actualDistanceMeters,
          durationSeconds: input.actualDurationSeconds,
        }),
      ],
    );

    const ledgerTx = buildTripSettlement({
      transactionId: randomUUID(),
      tripId: input.tripId,
      driverId: input.driverId,
      currency: trip.currency,
      fareCents,
      commissionCents: split.commissionCents,
      paymentMethod: trip.payment_method,
    });
    await postTransaction(tx, ledgerTx);

    await appendEvent(tx, input.tripId, trip.status, 'COMPLETED', 'driver', input.driverId, {
      quotedCents,
      fareCents,
      recalculated,
      commissionBps: trip.commission_bps,
      commissionCents: split.commissionCents,
    });

    return {
      tripId: input.tripId,
      fareCents,
      commissionCents: split.commissionCents,
      driverEarningsCents: split.driverEarningsCents,
      currency: trip.currency,
      recalculated,
    };
  });

  await releaseDriverLock(input.driverId);
  publish('trip', input.tripId, 'trip.completed', result);
  return result;
}

// ───────────────────────────── Cancelar ───────────────────────────────────────

export interface CancelTripInput {
  readonly tripId: string;
  readonly actor: Actor;
  readonly actorId: string;
  readonly reason: string | null;
}

export async function cancelTrip(input: CancelTripInput): Promise<{ feeCents: number; reason: string }> {
  const result = await withTransaction(async (tx) => {
    const trip = await getTripForUpdate(tx, input.tripId);
    assertCanCancel(trip, input);
    transition({ from: trip.status, to: 'CANCELED', actor: input.actor });

    const pricing = await getActivePricing(tx, trip.city_id, trip.currency);
    const outcome = evaluateCancellation(
      trip.status,
      trip.accepted_at,
      input.actor,
      { graceSecondsAfterAccept: pricing.cancellationGraceSeconds, feeCents: pricing.cancellationFeeCents },
    );

    await updateStatus(
      tx, input.tripId, trip.status, 'CANCELED',
      `canceled_by = $4, cancel_reason = $5, cancellation_fee_cents = $6`,
      [input.actor, input.reason, outcome.feeCents],
    );
    await appendEvent(tx, input.tripId, trip.status, 'CANCELED', input.actor, input.actorId, {
      chargeable: outcome.chargeable,
      feeCents: outcome.feeCents,
      reason: outcome.reason,
    });
    await expireOffers(tx, input.tripId);

    return { feeCents: outcome.feeCents, reason: outcome.reason, driverId: trip.driver_id };
  });

  if (result.driverId) await releaseDriverLock(result.driverId);
  publish('trip', input.tripId, 'trip.canceled', {
    tripId: input.tripId,
    by: input.actor,
    feeCents: result.feeCents,
  });
  return { feeCents: result.feeCents, reason: result.reason };
}

function assertCanCancel(trip: TripRow, input: CancelTripInput): void {
  if (input.actor === 'rider' && trip.rider_id !== input.actorId) {
    throw new ForbiddenError('este viaje no es tuyo');
  }
  if (input.actor === 'driver' && trip.driver_id !== input.actorId) {
    throw new ForbiddenError('este viaje no es tuyo');
  }
}

async function expireOffers(tx: Queryable, tripId: string): Promise<void> {
  await tx.query(
    `UPDATE trip_offers SET outcome = 'superseded', decided_at = now()
      WHERE trip_id = $1 AND outcome IS NULL`,
    [tripId],
  );
}

// ───────────────────────────── Consultas ──────────────────────────────────────

export async function getTripDetail(tripId: string, requesterId: string, isStaff: boolean): Promise<{
  trip: TripRow;
  events: Awaited<ReturnType<typeof listEvents>>;
}> {
  return withTransaction(async (tx) => {
    const trip = await getTripForUpdate(tx, tripId);
    if (!isStaff && trip.rider_id !== requesterId && trip.driver_id !== requesterId) {
      // Un conductor con OFERTA VIGENTE todavía no es trip.driver_id: eso se
      // asigna recién al aceptar. Pero necesita ver origen, destino y tarifa
      // para decidir, y la oferta que le llega por WebSocket solo trae tripId,
      // ETA y distancia.
      //
      // Sin esta excepción la pantalla de oferta recibía 403, se quedaba en
      // "Cargando el viaje…" y el botón Aceptar nunca se habilitaba: el
      // conductor no podía tomar un viaje desde la app. El smoke no lo detectó
      // porque llama a acceptTrip directo, sin pasar por getTrip.
      //
      // Mismo criterio que acceptTrip: oferta sin resolver y sin vencer. El
      // acceso dura lo que dura la oferta y es exclusivo de esa ola, así que no
      // abre el viaje a cualquier conductor.
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM trip_offers
          WHERE trip_id = $1 AND driver_id = $2 AND outcome IS NULL AND expires_at > now()`,
        [tripId, requesterId],
      );
      if (!rows[0]) throw new ForbiddenError('no participás de este viaje');
    }
    const events = await listEvents(tx, tripId);
    return { trip, events };
  });
}

export function assertPaymentMethod(value: string): PaymentMethod {
  if (value === 'cash' || value === 'card' || value === 'wallet') return value;
  throw new BadRequestError(`método de pago inválido: ${value}`);
}
