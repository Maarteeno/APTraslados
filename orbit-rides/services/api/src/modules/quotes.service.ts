/**
 * Servicio de cotizaciones.
 *
 * El cliente pide, el servidor calcula, firma y guarda. El cliente después
 * manda solo el quoteId. Nunca acepta un monto que venga del cliente.
 */

import { randomUUID } from 'node:crypto';
import {
  computeFare, signQuote, type LatLng, type QuotePayload, type SignedQuote,
} from '@orbit/domain';
import { loadConfig } from '../config/index.js';
import { withTransaction, type Queryable } from '../db/pool.js';
import { findCityContaining, getActivePricing } from './cities.repo.js';
import { insertQuote } from './quotes.repo.js';
import type { RoutingProvider } from '../lib/routing.js';

export interface CreateQuoteRequest {
  readonly riderId: string;
  readonly origin: LatLng;
  readonly originAddress: string | null;
  readonly destination: LatLng;
  readonly destinationAddress: string | null;
}

export interface CreateQuoteResult {
  readonly quoteId: string;
  readonly cityId: string;
  readonly currency: string;
  readonly fareCents: number;
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly surgeMultiplier: number;
  readonly expiresAt: string;
  readonly signature: string;
  readonly routeProvider: string;
  /** Trazado real en polyline6, o null si se estimó localmente. */
  readonly routePolyline: string | null;
  /** Maniobras para el cartel de navegación. Vacío con la estimación local. */
  readonly routeSteps: unknown;
  readonly breakdown: {
    baseCents: number;
    distanceCents: number;
    timeCents: number;
    serviceFeeCents: number;
    minimumAppliedCents: number;
    surgeCents: number;
    totalCents: number;
  };
}

export async function createQuote(
  request: CreateQuoteRequest,
  routing: RoutingProvider,
): Promise<CreateQuoteResult> {
  const config = loadConfig();

  return withTransaction(async (tx: Queryable) => {
    const city = await findCityContaining(tx, request.origin);
    const pricing = await getActivePricing(tx, city.id, city.currency);
    const route = await routing.route(request.origin, request.destination);

    // El surge sale de la demanda observada. Mientras no exista ese cálculo,
    // 1.0 explícito es mejor que un número inventado.
    const surgeMultiplier = 1;
    const fare = computeFare(route, pricing, surgeMultiplier);

    const now = Date.now();
    const expiresAtMs = now + config.QUOTE_TTL_SECONDS * 1000;

    const quoteId = randomUUID();
    const payload: QuotePayload = {
      quoteId,
      cityId: city.id,
      riderId: request.riderId,
      origin: { lat: request.origin.lat, lng: request.origin.lng },
      destination: { lat: request.destination.lat, lng: request.destination.lng },
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      surgeMultiplier,
      totalCents: fare.totalCents,
      currency: city.currency,
      issuedAt: now,
      expiresAt: expiresAtMs,
    };
    const signed: SignedQuote = signQuote(payload, config.QUOTE_SIGNING_SECRET);

    const insertedId = await insertQuote(tx, {
      // El MISMO id que se firmó. La base no lo genera.
      id: quoteId,
      riderId: request.riderId,
      cityId: city.id,
      origin: request.origin,
      originAddress: request.originAddress,
      destination: request.destination,
      destinationAddress: request.destinationAddress,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      surgeMultiplier,
      fareCents: fare.totalCents,
      currency: city.currency,
      breakdown: fare,
      signature: signed.signature,
      // El JSON exacto que se firmó. Al canjear se verifica contra este texto,
      // sin re-derivar el payload desde las columnas normalizadas.
      signedPayload: JSON.stringify(payload),
      // Fuera de la firma: es dato de presentación, no de precio.
      routePolyline: route.polyline,
      routeSteps: route.steps,
      expiresAt: new Date(expiresAtMs),
    });

    return {
      quoteId: insertedId,
      cityId: city.id,
      currency: city.currency,
      fareCents: fare.totalCents,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      surgeMultiplier,
      expiresAt: new Date(expiresAtMs).toISOString(),
      signature: signed.signature,
      routeProvider: route.provider,
      routePolyline: route.polyline,
      routeSteps: route.steps,
      breakdown: {
        baseCents: fare.baseCents,
        distanceCents: fare.distanceCents,
        timeCents: fare.timeCents,
        serviceFeeCents: fare.serviceFeeCents,
        minimumAppliedCents: fare.minimumAppliedCents,
        surgeCents: fare.surgeCents,
        totalCents: fare.totalCents,
      },
    };
  });
}
