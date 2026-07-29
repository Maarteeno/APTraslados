import type { Queryable } from '../db/pool.js';
import { NotFoundError } from '../lib/errors.js';
import type { DriverCandidate } from '@orbit/domain';

export interface DriverEligibilityRow {
  driver_id: string;
  rating_avg: string | null;
  acceptance_rate: string | null;
  cancellation_rate: string | null;
  onboarding_approved: boolean;
  subscription_active: boolean;
  documents_valid: boolean;
  has_active_trip: boolean;
  vehicle_category: string | null;
  vehicle_id: string | null;
  commission_bps: number | null;
}

/**
 * Una sola consulta que responde todo lo que el dispatch necesita saber de un
 * conjunto de conductores. Evita el N+1 clásico de "traigo conductores y
 * después consulto suscripción y documentos de cada uno".
 */
export async function loadEligibility(
  tx: Queryable,
  driverIds: readonly string[],
): Promise<Map<string, DriverEligibilityRow>> {
  if (driverIds.length === 0) return new Map();
  const { rows } = await tx.query<DriverEligibilityRow>(
    `SELECT d.user_id AS driver_id,
            d.rating_avg,
            d.acceptance_rate,
            d.cancellation_rate,
            (d.onboarding_status = 'approved') AS onboarding_approved,
            COALESCE(s.live, FALSE) AS subscription_active,
            COALESCE(doc.valid, FALSE) AS documents_valid,
            EXISTS (
              SELECT 1 FROM trips t
               WHERE t.driver_id = d.user_id
                 AND t.status IN ('ACCEPTED','ARRIVED','IN_PROGRESS')
            ) AS has_active_trip,
            v.category AS vehicle_category,
            v.id       AS vehicle_id,
            s.commission_bps
       FROM drivers d
       LEFT JOIN vehicles v
              ON v.driver_id = d.user_id AND v.is_active
       LEFT JOIN LATERAL (
              SELECT (sub.status IN ('trialing','active') AND sub.current_period_end > now()) AS live,
                     p.commission_bps
                FROM subscriptions sub
                JOIN plans p ON p.id = sub.plan_id
               WHERE sub.driver_id = d.user_id
                 AND sub.status IN ('trialing','active','past_due')
               LIMIT 1
            ) s ON TRUE
       LEFT JOIN LATERAL (
              -- Documentos: tienen que estar los obligatorios, aprobados y sin vencer.
              SELECT bool_and(dd.status = 'approved'
                              AND (dd.expires_at IS NULL OR dd.expires_at >= CURRENT_DATE)) AS valid
                FROM driver_documents dd
               WHERE dd.driver_id = d.user_id
                 AND dd.kind IN ('license','vehicle_registration','insurance')
            ) doc ON TRUE
      WHERE d.user_id = ANY($1::uuid[])`,
    [driverIds as string[]],
  );
  return new Map(rows.map((r) => [r.driver_id, r]));
}

export interface CandidateBuildInput {
  readonly driverId: string;
  readonly lat: number;
  readonly lng: number;
  readonly idleMinutes: number;
}

/** Cruza lo que dice Redis (posición) con lo que dice Postgres (elegibilidad). */
export function toCandidate(
  input: CandidateBuildInput,
  row: DriverEligibilityRow,
  requiredCategory: string,
): DriverCandidate {
  return {
    driverId: input.driverId,
    position: { lat: input.lat, lng: input.lng },
    ratingAvg: row.rating_avg === null ? 4.6 : Number(row.rating_avg),
    acceptanceRate: row.acceptance_rate === null ? 0.7 : Number(row.acceptance_rate),
    cancellationRate: row.cancellation_rate === null ? 0 : Number(row.cancellation_rate),
    idleMinutes: input.idleMinutes,
    vehicleCategory: row.vehicle_category ?? requiredCategory,
    onboardingApproved: row.onboarding_approved,
    subscriptionActive: row.subscription_active,
    documentsValid: row.documents_valid,
    hasActiveTrip: row.has_active_trip,
  };
}

export interface DriverCommission {
  readonly commissionBps: number;
  readonly vehicleId: string | null;
}

/**
 * Comisión vigente del conductor. Si no tiene suscripción viva cae al plan
 * free de la ciudad: no se lo echa de la plataforma por un problema de cobro,
 * simplemente pasa a la comisión más alta.
 */
export async function getDriverCommission(
  tx: Queryable,
  driverId: string,
  cityId: string,
): Promise<DriverCommission> {
  const { rows } = await tx.query<{ commission_bps: number; vehicle_id: string | null }>(
    `SELECT COALESCE(active_plan.commission_bps, free_plan.commission_bps) AS commission_bps,
            v.id AS vehicle_id
       FROM drivers d
       LEFT JOIN vehicles v ON v.driver_id = d.user_id AND v.is_active
       LEFT JOIN LATERAL (
              SELECT p.commission_bps
                FROM subscriptions s
                JOIN plans p ON p.id = s.plan_id
               WHERE s.driver_id = d.user_id
                 AND s.status IN ('trialing','active')
                 AND s.current_period_end > now()
               LIMIT 1
            ) active_plan ON TRUE
       LEFT JOIN LATERAL (
              SELECT p.commission_bps
                FROM plans p
               WHERE p.city_id = $2 AND p.code = 'free' AND p.is_active
               ORDER BY p.effective_from DESC
               LIMIT 1
            ) free_plan ON TRUE
      WHERE d.user_id = $1`,
    [driverId, cityId],
  );
  const row = rows[0];
  if (!row || row.commission_bps === null) {
    throw new NotFoundError('plan de comisión del conductor');
  }
  return { commissionBps: row.commission_bps, vehicleId: row.vehicle_id };
}

export async function setOnlineStatus(
  tx: Queryable,
  driverId: string,
  isOnline: boolean,
  lat: number,
  lng: number,
  bearing: number | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO driver_last_position (driver_id, position, bearing, is_online, updated_at)
     VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4, $5, now())
     ON CONFLICT (driver_id) DO UPDATE
        SET position = EXCLUDED.position,
            bearing = EXCLUDED.bearing,
            is_online = EXCLUDED.is_online,
            updated_at = now()`,
    [driverId, lng, lat, bearing, isOnline],
  );
}
