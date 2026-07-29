import type { Queryable } from '../db/pool.js';
import { NotFoundError, UnprocessableError } from '../lib/errors.js';
import type { CurrencyCode, LatLng, PricingParams } from '@orbit/domain';

export interface CityRow {
  id: string;
  slug: string;
  name: string;
  currency: CurrencyCode;
  timezone: string;
  is_live: boolean;
}

export interface PricingRow {
  base_cents: string;
  per_km_cents: string;
  per_minute_cents: string;
  minimum_cents: string;
  service_fee_cents: string;
  round_to_cents: string;
  cancellation_fee_cents: string;
  cancellation_grace_seconds: number;
}

/** Ciudad que contiene el punto. Si no hay, el viaje está fuera de zona operativa. */
export async function findCityContaining(tx: Queryable, point: LatLng): Promise<CityRow> {
  const { rows } = await tx.query<CityRow>(
    `SELECT id, slug, name, currency, timezone, is_live
       FROM cities
      WHERE is_live
        AND ST_Covers(boundary, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)
      LIMIT 1`,
    [point.lng, point.lat],
  );
  const city = rows[0];
  if (!city) throw new UnprocessableError('el origen está fuera de nuestra zona de cobertura');
  return city;
}

export async function getCity(tx: Queryable, cityId: string): Promise<CityRow> {
  const { rows } = await tx.query<CityRow>(
    `SELECT id, slug, name, currency, timezone, is_live FROM cities WHERE id = $1`,
    [cityId],
  );
  const city = rows[0];
  if (!city) throw new NotFoundError('ciudad');
  return city;
}

/** Tarifas vigentes. Se toma la última fila con effective_from <= now. */
export async function getActivePricing(
  tx: Queryable,
  cityId: string,
  currency: CurrencyCode,
): Promise<PricingParams & { cancellationFeeCents: number; cancellationGraceSeconds: number }> {
  const { rows } = await tx.query<PricingRow>(
    `SELECT base_cents, per_km_cents, per_minute_cents, minimum_cents,
            service_fee_cents, round_to_cents,
            cancellation_fee_cents, cancellation_grace_seconds
       FROM city_pricing
      WHERE city_id = $1 AND effective_from <= now()
      ORDER BY effective_from DESC
      LIMIT 1`,
    [cityId],
  );
  const p = rows[0];
  if (!p) throw new UnprocessableError('la ciudad no tiene tarifas configuradas');
  return {
    currency,
    baseCents: Number(p.base_cents),
    perKmCents: Number(p.per_km_cents),
    perMinuteCents: Number(p.per_minute_cents),
    minimumCents: Number(p.minimum_cents),
    serviceFeeCents: Number(p.service_fee_cents),
    roundToCents: Number(p.round_to_cents),
    cancellationFeeCents: Number(p.cancellation_fee_cents),
    cancellationGraceSeconds: p.cancellation_grace_seconds,
  };
}
