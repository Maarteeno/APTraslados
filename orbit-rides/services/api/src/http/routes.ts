/**
 * Rutas HTTP.
 *
 * Las rutas son finas a propósito: validan, delegan al servicio y formatean.
 * Cero lógica de negocio acá.
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { db, healthcheck, withTransaction } from '../db/pool.js';
import { redisHealthcheck, setDriverPosition, removeDriverFromIndex } from '../db/redis.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { buildRoutingProvider } from '../lib/routing.js';
import { logger } from '../lib/logger.js';
import { requirePrincipal, requireRole } from '../auth/plugin.js';
import { issueDevToken } from '../auth/tokens.js';
import { createQuote } from '../modules/quotes.service.js';
import {
  acceptTrip, cancelTrip, completeTrip, getTripDetail, markArrived,
  rejectOffer, requestTrip, startTrip,
} from '../modules/trips.service.js';
import { setOnlineStatus } from '../modules/drivers.repo.js';
import { findActiveTripForUser, findOpenOfferForDriver } from '../modules/trips.repo.js';
import { getBalanceCents, findUnbalancedTransactions } from '../modules/ledger.repo.js';
import { channelStats } from '../ws/hub.js';
import { enqueueTrip, cancelDispatch, pendingCount } from '../workers/dispatcher.js';
import {
  cancelTripBody, completeTripBody, createQuoteBody, devLoginBody,
  positionBody, requestTripBody, uuidParam,
} from './schemas.js';
import { parse } from './plugin.js';

const config = loadConfig();
const routing = buildRoutingProvider({
  osrmUrl: config.OSRM_URL,
  mapboxToken: config.MAPBOX_TOKEN,
  timeoutMs: config.ROUTING_TIMEOUT_MS,
  onFallback: (err) =>
    logger.warn({ err }, 'el proveedor de ruteo falló, se usa la estimación local'),
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ── Salud ───────────────────────────────────────────────────────────────
  //
  // logLevel: 'silent' porque el healthcheck del contenedor pega cada 15 s y
  // ahoga el log con ruido: 50 líneas de "incoming request /health/ready" y
  // cero información sobre lo que realmente pasó. Si el healthcheck falla, lo
  // reporta Docker en `docker compose ps`, no hace falta el log de cada 200.
  const healthOpts = { config: { public: true }, logLevel: 'silent' } as const;

  app.get('/health', healthOpts, async () => ({ status: 'ok' }));

  app.get('/health/ready', healthOpts, async (_request, reply) => {
    const [pg, rd] = await Promise.all([healthcheck(), redisHealthcheck()]);
    const ready = pg && rd;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      postgres: pg ? 'up' : 'down',
      redis: rd ? 'up' : 'down',
      websocket: channelStats(),
      dispatchQueue: pendingCount(),
    });
  });

  // ── Login de desarrollo ─────────────────────────────────────────────────
  // Existe solo para poder probar desde el emulador sin montar Firebase.
  // La config prohíbe AUTH_MODE=dev en producción.
  app.post('/v1/auth/dev-login', { config: { public: true } }, async (request, reply) => {
    if (config.AUTH_MODE !== 'dev') {
      throw new ForbiddenError('el login de desarrollo está deshabilitado');
    }
    const body = parse(devLoginBody, request.body);
    const { rows } = await db.query<{ id: string; role: string; full_name: string }>(
      `SELECT id, role, full_name FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL`,
      [body.phone],
    );
    const user = rows[0];
    if (!user) throw new NotFoundError('usuario con ese teléfono (corré el seed primero)');
    return reply.send({
      token: issueDevToken(user.id),
      user: { id: user.id, role: user.role, fullName: user.full_name },
    });
  });

  app.get('/v1/me', async (request) => {
    const principal = requirePrincipal(request);
    const { rows } = await db.query<{ id: string; full_name: string; role: string; city_id: string | null }>(
      `SELECT id, full_name, role, city_id FROM users WHERE id = $1`,
      [principal.userId],
    );
    const me = rows[0];
    if (!me) throw new NotFoundError('usuario');
    return { id: me.id, fullName: me.full_name, role: me.role, cityId: me.city_id };
  });

  // ── Cotizaciones ────────────────────────────────────────────────────────
  app.post('/v1/quotes', async (request) => {
    const principal = requireRole(request, 'rider', 'admin');
    const body = parse(createQuoteBody, request.body);
    return createQuote(
      {
        riderId: principal.userId,
        origin: body.origin,
        originAddress: body.originAddress ?? null,
        destination: body.destination,
        destinationAddress: body.destinationAddress ?? null,
      },
      routing,
    );
  });

  // ── Viajes (pasajero) ───────────────────────────────────────────────────
  app.post('/v1/trips', async (request, reply) => {
    const principal = requireRole(request, 'rider', 'admin');
    const body = parse(requestTripBody, request.body);
    const result = await requestTrip({
      riderId: principal.userId,
      quoteId: body.quoteId,
      paymentMethod: body.paymentMethod,
    });
    // El dispatch arranca en background: el pasajero no espera el matching.
    enqueueTrip(result.tripId);
    return reply.status(201).send(result);
  });

  // La app lo llama al abrir: si el usuario cerró la app a mitad de un viaje,
  // tiene que volver a la pantalla del viaje y no al mapa vacío.
  app.get('/v1/trips/active', async (request) => {
    const principal = requirePrincipal(request);
    const trip = await withTransaction((tx) => findActiveTripForUser(tx, principal.userId));
    if (!trip) return { trip: null };
    return {
      trip: {
        id: trip.id,
        status: trip.status,
        driverId: trip.driver_id,
        origin: { lat: trip.origin_lat, lng: trip.origin_lng, address: trip.origin_address },
        destination: { lat: trip.destination_lat, lng: trip.destination_lng, address: trip.destination_address },
        paymentMethod: trip.payment_method,
        // El viaje activo es lo primero que carga cada app al abrir con un viaje
        // en curso. Sin los trazados acá, el mapa dibujaría la recta hasta que
        // llegue el detalle completo, y se vería un parpadeo.
        routePolyline: trip.route_polyline,
        pickupPolyline: trip.pickup_polyline,
        routeSteps: trip.route_steps ?? [],
        pickupSteps: trip.pickup_steps ?? [],
        requestedAt: trip.requested_at,
      },
    };
  });

  app.get('/v1/trips/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parse(uuidParam, request.params);
    const isStaff = principal.role === 'admin' || principal.role === 'support';
    const { trip, events } = await getTripDetail(id, principal.userId, isStaff);
    return {
      id: trip.id,
      status: trip.status,
      riderId: trip.rider_id,
      driverId: trip.driver_id,
      origin: { lat: trip.origin_lat, lng: trip.origin_lng, address: trip.origin_address },
      destination: { lat: trip.destination_lat, lng: trip.destination_lng, address: trip.destination_address },
      currency: trip.currency,
      fareCents: trip.fare_cents === null ? null : Number(trip.fare_cents),
      commissionBps: trip.commission_bps,
      commissionCents: trip.commission_cents === null ? null : Number(trip.commission_cents),
      driverEarningsCents: trip.driver_earnings_cents === null ? null : Number(trip.driver_earnings_cents),
      paymentMethod: trip.payment_method,
      cancellationFeeCents: Number(trip.cancellation_fee_cents),
      canceledBy: trip.canceled_by,
      // Trazados en polyline6, para que las apps dibujen el camino real y no
      // una recta entre dos puntos. Pueden ser null: con la estimación local no
      // hay geometría, y la de acercamiento solo existe después de aceptar.
      routePolyline: trip.route_polyline,
      pickupPolyline: trip.pickup_polyline,
      routeSteps: trip.route_steps ?? [],
      pickupSteps: trip.pickup_steps ?? [],
      timestamps: {
        requestedAt: trip.requested_at,
        acceptedAt: trip.accepted_at,
        arrivedAt: trip.arrived_at,
        startedAt: trip.started_at,
        completedAt: trip.completed_at,
      },
      events: events.map((e) => ({
        from: e.from_status, to: e.to_status, actor: e.actor, at: e.at, payload: e.payload,
      })),
    };
  });

  app.post('/v1/trips/:id/cancel', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parse(uuidParam, request.params);
    const body = parse(cancelTripBody, request.body ?? {});
    const actor = principal.role === 'driver' ? 'driver' : 'rider';
    const result = await cancelTrip({
      tripId: id, actor, actorId: principal.userId, reason: body.reason ?? null,
    });
    cancelDispatch(id);
    return result;
  });

  // ── Viajes (conductor) ──────────────────────────────────────────────────
  app.get('/v1/driver/offer', async (request) => {
    const principal = requireRole(request, 'driver');
    const offer = await withTransaction((tx) => findOpenOfferForDriver(tx, principal.userId));
    if (!offer) return { offer: null };
    return { offer: { tripId: offer.trip_id, expiresAt: offer.expires_at } };
  });

  app.post('/v1/trips/:id/accept', async (request) => {
    const principal = requireRole(request, 'driver');
    const { id } = parse(uuidParam, request.params);
    const result = await acceptTrip({ tripId: id, driverId: principal.userId, routing });
    cancelDispatch(id);
    return result;
  });

  app.post('/v1/trips/:id/reject', async (request) => {
    const principal = requireRole(request, 'driver');
    const { id } = parse(uuidParam, request.params);
    await rejectOffer(id, principal.userId);
    return { ok: true };
  });

  app.post('/v1/trips/:id/arrived', async (request) => {
    const principal = requireRole(request, 'driver');
    const { id } = parse(uuidParam, request.params);
    await markArrived(id, principal.userId);
    return { ok: true };
  });

  app.post('/v1/trips/:id/start', async (request) => {
    const principal = requireRole(request, 'driver');
    const { id } = parse(uuidParam, request.params);
    await startTrip(id, principal.userId);
    return { ok: true };
  });

  app.post('/v1/trips/:id/complete', async (request) => {
    const principal = requireRole(request, 'driver');
    const { id } = parse(uuidParam, request.params);
    const body = parse(completeTripBody, request.body);
    return completeTrip({
      tripId: id,
      driverId: principal.userId,
      actualDistanceMeters: body.actualDistanceMeters,
      actualDurationSeconds: body.actualDurationSeconds,
    });
  });

  // ── Posición del conductor ──────────────────────────────────────────────
  app.post('/v1/driver/position', async (request) => {
    const principal = requireRole(request, 'driver');
    const body = parse(positionBody, request.body);
    if (!principal.cityId) throw new BadRequestError('tu cuenta no tiene ciudad asignada');

    if (body.isOnline) {
      await setDriverPosition(
        principal.cityId, principal.userId,
        { lat: body.lat, lng: body.lng }, body.bearing ?? null,
      );
    } else {
      await removeDriverFromIndex(principal.cityId, principal.userId);
    }
    await withTransaction((tx) =>
      setOnlineStatus(tx, principal.userId, body.isOnline, body.lat, body.lng, body.bearing ?? null),
    );
    return { ok: true, isOnline: body.isOnline };
  });

  app.get('/v1/driver/earnings', async (request) => {
    const principal = requireRole(request, 'driver');
    const balance = await withTransaction((tx) =>
      getBalanceCents(tx, 'driver_balance', principal.userId, 'UYU'),
    );
    const { rows } = await db.query<{ trips: string; gross: string | null; commission: string | null }>(
      `SELECT count(*)::text AS trips,
              SUM(fare_cents)::text AS gross,
              SUM(commission_cents)::text AS commission
         FROM trips
        WHERE driver_id = $1 AND status = 'COMPLETED'
          AND completed_at >= date_trunc('week', now())`,
      [principal.userId],
    );
    const row = rows[0];

    // El saldo contable es un solo número con signo, y mostrarlo así es una
    // trampa: en un viaje en efectivo el conductor NOS DEBE la comisión, y un
    // campo llamado "pago pendiente" con un número positivo dice exactamente lo
    // contrario. Se parte en dos campos, cada uno sin ambigüedad.
    //
    // Convención: driver_balance negativo = le debemos; positivo = él nos debe.
    const owedToDriver = Math.max(0, -balance);
    const owedByDriver = Math.max(0, balance);

    return {
      /** Lo que la plataforma le debe al conductor. Siempre >= 0. */
      pendingPayoutCents: owedToDriver,
      /** Lo que el conductor le debe a la plataforma, típico de viajes en efectivo. Siempre >= 0. */
      owedToPlatformCents: owedByDriver,
      /** Saldo contable crudo, con signo. Para auditoría. */
      balanceCents: balance,
      thisWeek: {
        trips: Number(row?.trips ?? '0'),
        grossCents: Number(row?.gross ?? '0'),
        commissionCents: Number(row?.commission ?? '0'),
      },
    };
  });

  // ── Admin ───────────────────────────────────────────────────────────────
  app.get('/v1/admin/ledger/integrity', async (request) => {
    requireRole(request, 'admin');
    const unbalanced = await withTransaction((tx) => findUnbalancedTransactions(tx));
    return {
      // Si esto no está vacío, hay un bug de dinero. Debería estar en un alerta.
      healthy: unbalanced.length === 0,
      unbalancedTransactions: unbalanced,
      checkedAt: new Date().toISOString(),
      correlationId: randomUUID(),
    };
  });

  app.get('/v1/admin/trips/live', async (request) => {
    requireRole(request, 'admin', 'support');
    const { rows } = await db.query<{
      id: string; status: string; rider_name: string; driver_name: string | null;
      requested_at: Date; origin_address: string | null;
    }>(
      `SELECT t.id, t.status::text AS status,
              r.full_name AS rider_name,
              dv.full_name AS driver_name,
              t.requested_at, t.origin_address
         FROM trips t
         JOIN users r ON r.id = t.rider_id
         LEFT JOIN users dv ON dv.id = t.driver_id
        WHERE t.status NOT IN ('COMPLETED','CANCELED','NO_DRIVERS')
        ORDER BY t.requested_at DESC
        LIMIT 100`,
    );
    return { trips: rows };
  });
}
