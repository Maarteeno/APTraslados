import type { Queryable } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import type { CurrencyCode, FareBreakdown } from '@orbit/domain';

export interface QuoteRow {
  id: string;
  rider_id: string;
  city_id: string;
  origin_lat: number;
  origin_lng: number;
  origin_address: string | null;
  destination_lat: number;
  destination_lng: number;
  destination_address: string | null;
  distance_meters: number;
  duration_seconds: number;
  surge_multiplier: string;
  fare_cents: string;
  currency: CurrencyCode;
  signature: string;
  signed_payload: string | null;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface InsertQuoteInput {
  /**
   * Id generado por la aplicación, NO por la base.
   *
   * Tiene que ser el mismo que se firmó. Antes se firmaba un randomUUID() y se
   * dejaba que gen_random_uuid() generara otro al insertar: la firma cubría un
   * id que nadie veía y la verificación fallaba siempre.
   */
  readonly id: string;
  readonly riderId: string;
  readonly cityId: string;
  readonly origin: { lat: number; lng: number };
  readonly originAddress: string | null;
  readonly destination: { lat: number; lng: number };
  readonly destinationAddress: string | null;
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly surgeMultiplier: number;
  readonly fareCents: number;
  readonly currency: CurrencyCode;
  readonly breakdown: FareBreakdown;
  readonly signature: string;
  /** JSON exacto que se firmó. Se verifica contra este texto, sin re-derivar. */
  readonly signedPayload: string;
  readonly expiresAt: Date;
}

export async function insertQuote(tx: Queryable, input: InsertQuoteInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO quotes (id, rider_id, city_id, origin, origin_address, destination, destination_address,
                         distance_meters, duration_seconds, surge_multiplier, fare_cents, currency,
                         breakdown, signature, signed_payload, expires_at)
     VALUES ($1, $2, $3,
             ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6,
             ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography, $9,
             $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING id`,
    [
      input.id, input.riderId, input.cityId,
      input.origin.lng, input.origin.lat, input.originAddress,
      input.destination.lng, input.destination.lat, input.destinationAddress,
      input.distanceMeters, input.durationSeconds, input.surgeMultiplier,
      input.fareCents, input.currency, JSON.stringify(input.breakdown),
      input.signature, input.signedPayload, input.expiresAt,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('el INSERT de quotes no devolvió id');
  return row.id;
}

const SELECT_QUOTE = `
  SELECT id, rider_id, city_id,
         ST_Y(origin::geometry)      AS origin_lat,
         ST_X(origin::geometry)      AS origin_lng,
         origin_address,
         ST_Y(destination::geometry) AS destination_lat,
         ST_X(destination::geometry) AS destination_lng,
         destination_address,
         distance_meters, duration_seconds, surge_multiplier,
         fare_cents, currency, signature, signed_payload, expires_at, consumed_at
    FROM quotes`;

export async function getQuote(tx: Queryable, quoteId: string): Promise<QuoteRow> {
  const { rows } = await tx.query<QuoteRow>(`${SELECT_QUOTE} WHERE id = $1`, [quoteId]);
  const quote = rows[0];
  if (!quote) throw new NotFoundError('cotización');
  return quote;
}

/**
 * Marca la cotización como consumida. El UPDATE condicional es la protección
 * real contra doble uso: si dos requests llegan a la vez, uno solo afecta filas.
 */
export async function consumeQuote(tx: Queryable, quoteId: string): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE quotes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
    [quoteId],
  );
  if (rowCount === 0) throw new ConflictError('esta cotización ya fue usada para crear un viaje');
}
