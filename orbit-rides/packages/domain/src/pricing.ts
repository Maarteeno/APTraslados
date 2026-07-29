/**
 * Motor de tarifas.
 *
 * Regla que ordena todo: el cliente NUNCA manda el monto. Pide una cotización,
 * el servidor la calcula, la firma y le pone vencimiento. Al crear el viaje el
 * cliente manda el quoteId; el servidor revalida firma y vigencia.
 *
 * Sin esto, la tarifa se edita desde el celular con dos líneas de JavaScript.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertNonNegative, roundHalfEven, type Cents, type CurrencyCode } from './money.js';

export class PricingError extends Error {}
export class QuoteInvalidError extends Error {}
export class QuoteExpiredError extends Error {}

/** Parámetros por ciudad. Viven en base, versionados por vigencia: se cambian sin deployar. */
export interface PricingParams {
  readonly currency: CurrencyCode;
  readonly baseCents: Cents;
  readonly perKmCents: Cents;
  readonly perMinuteCents: Cents;
  readonly minimumCents: Cents;
  /** Fee fijo de servicio al pasajero. Es la palanca limpia para cubrir el costo de procesamiento. */
  readonly serviceFeeCents: Cents;
  /** Redondeo del total al múltiplo más cercano (en centavos). 0 = sin redondeo. */
  readonly roundToCents: Cents;
}

export interface RouteEstimate {
  readonly distanceMeters: number;
  readonly durationSeconds: number;
}

export interface FareBreakdown {
  readonly baseCents: Cents;
  readonly distanceCents: Cents;
  readonly timeCents: Cents;
  readonly serviceFeeCents: Cents;
  readonly subtotalCents: Cents;
  readonly minimumAppliedCents: Cents;
  readonly surgeMultiplier: number;
  readonly surgeCents: Cents;
  readonly totalCents: Cents;
}

export function assertPricingParams(p: PricingParams): PricingParams {
  assertNonNegative(p.baseCents, 'baseCents');
  assertNonNegative(p.perKmCents, 'perKmCents');
  assertNonNegative(p.perMinuteCents, 'perMinuteCents');
  assertNonNegative(p.minimumCents, 'minimumCents');
  assertNonNegative(p.serviceFeeCents, 'serviceFeeCents');
  assertNonNegative(p.roundToCents, 'roundToCents');
  return p;
}

export function assertSurge(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 5) {
    throw new PricingError(`surge fuera de rango [1,5]: ${multiplier}`);
  }
  return multiplier;
}

function roundToMultiple(value: Cents, multiple: Cents): Cents {
  if (multiple <= 0) return value;
  return roundHalfEven(value / multiple) * multiple;
}

/** Calcula la tarifa. Determinista: mismos inputs, mismo output, siempre. */
export function computeFare(
  route: RouteEstimate,
  params: PricingParams,
  surgeMultiplier = 1,
): FareBreakdown {
  assertPricingParams(params);
  assertSurge(surgeMultiplier);
  if (!Number.isFinite(route.distanceMeters) || route.distanceMeters < 0) {
    throw new PricingError(`distancia inválida: ${route.distanceMeters}`);
  }
  if (!Number.isFinite(route.durationSeconds) || route.durationSeconds < 0) {
    throw new PricingError(`duración inválida: ${route.durationSeconds}`);
  }

  const distanceCents = roundHalfEven((route.distanceMeters / 1000) * params.perKmCents);
  const timeCents = roundHalfEven((route.durationSeconds / 60) * params.perMinuteCents);

  const rideCents = params.baseCents + distanceCents + timeCents;
  // La tarifa mínima se aplica ANTES del surge y NO incluye el fee de servicio,
  // que es un cargo aparte y no se descuenta contra el mínimo.
  const flooredCents = Math.max(rideCents, params.minimumCents);
  const minimumAppliedCents = flooredCents - rideCents;

  const surgedCents = roundHalfEven(flooredCents * surgeMultiplier);
  const surgeCents = surgedCents - flooredCents;

  const beforeRounding = surgedCents + params.serviceFeeCents;
  const totalCents = roundToMultiple(beforeRounding, params.roundToCents);

  return {
    baseCents: params.baseCents,
    distanceCents,
    timeCents,
    serviceFeeCents: params.serviceFeeCents,
    subtotalCents: rideCents,
    minimumAppliedCents,
    surgeMultiplier,
    surgeCents,
    totalCents,
  };
}

// ─────────────────────────────── Cotización firmada ───────────────────────────

export interface QuotePayload {
  readonly quoteId: string;
  readonly cityId: string;
  readonly riderId: string;
  readonly origin: { lat: number; lng: number };
  readonly destination: { lat: number; lng: number };
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly surgeMultiplier: number;
  readonly totalCents: Cents;
  readonly currency: CurrencyCode;
  /** Epoch en milisegundos. */
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SignedQuote {
  readonly payload: QuotePayload;
  readonly signature: string;
}

/**
 * Canonicaliza el payload antes de firmar. El orden de las claves de un objeto
 * JS no es contractual, así que serializar con JSON.stringify directo produce
 * firmas que dependen del orden de inserción. Esto lo hace determinista.
 */
function canonical(payload: QuotePayload): string {
  return JSON.stringify([
    payload.quoteId,
    payload.cityId,
    payload.riderId,
    payload.origin.lat,
    payload.origin.lng,
    payload.destination.lat,
    payload.destination.lng,
    payload.distanceMeters,
    payload.durationSeconds,
    payload.surgeMultiplier,
    payload.totalCents,
    payload.currency,
    payload.issuedAt,
    payload.expiresAt,
  ]);
}

export function signQuote(payload: QuotePayload, secret: string): SignedQuote {
  if (!secret || secret.length < 32) {
    throw new PricingError('el secreto de firma debe tener al menos 32 caracteres');
  }
  const signature = createHmac('sha256', secret).update(canonical(payload)).digest('base64url');
  return { payload, signature };
}

/**
 * Verifica firma y vigencia. Lanza QuoteInvalidError si fue alterada y
 * QuoteExpiredError si venció: son dos problemas distintos y el llamador
 * necesita distinguirlos (uno es un ataque, el otro es un usuario lento).
 */
export function verifyQuote(quote: SignedQuote, secret: string, now = Date.now()): QuotePayload {
  const expected = createHmac('sha256', secret).update(canonical(quote.payload)).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(quote.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new QuoteInvalidError('firma de cotización inválida');
  }
  if (now > quote.payload.expiresAt) {
    throw new QuoteExpiredError('la cotización venció');
  }
  return quote.payload;
}
