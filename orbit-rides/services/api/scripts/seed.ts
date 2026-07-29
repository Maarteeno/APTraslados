/**
 * Datos de prueba para poder usar la app desde el emulador de Android.
 *
 * Idempotente: se puede correr varias veces. Crea Montevideo con su polígono,
 * los tres planes, un pasajero, tres conductores con vehículos, documentos
 * aprobados y suscripciones vigentes.
 */

import { pool, withTransaction, type Queryable } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';

// Polígono operativo aproximado de Montevideo (suficiente para desarrollo).
const MVD_BOUNDARY =
  'POLYGON((-56.44 -34.75, -56.00 -34.75, -55.95 -34.95, -56.30 -34.98, -56.44 -34.92, -56.44 -34.75))';

interface SeedDriver {
  readonly phone: string;
  readonly name: string;
  readonly plan: 'free' | 'pro' | 'plus';
  readonly plate: string;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly color: string;
  readonly lat: number;
  readonly lng: number;
}

const DRIVERS: readonly SeedDriver[] = [
  { phone: '+59899774019', name: 'Adrián Pereda',  plan: 'pro',  plate: 'SBA4192', make: 'Bestune',   model: 'B70',  year: 2023, color: 'Gris',   lat: -34.9089, lng: -56.1601 },
  { phone: '+59899100002', name: 'Marcela Giles',  plan: 'free', plate: 'SCK1730', make: 'Chevrolet', model: 'Onix', year: 2022, color: 'Blanco', lat: -34.9145, lng: -56.1489 },
  { phone: '+59899100003', name: 'Rodrigo Ferrer', plan: 'free', plate: 'SBH2054', make: 'Fiat',      model: 'Cronos', year: 2021, color: 'Negro', lat: -34.9051, lng: -56.1712 },
];

async function seedCity(tx: Queryable): Promise<{ cityId: string }> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cities (slug, name, country_code, currency, timezone, boundary, is_live)
     VALUES ('montevideo', 'Montevideo', 'UY', 'UYU', 'America/Montevideo',
             ST_GeogFromText($1), TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_live = TRUE, boundary = ST_GeogFromText($1)
     RETURNING id`,
    [MVD_BOUNDARY],
  );
  const city = rows[0];
  if (!city) throw new Error('no se pudo crear la ciudad');

  // Tarifas: los mismos números del modelo financiero (docs/03).
  const existing = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM city_pricing WHERE city_id = $1`,
    [city.id],
  );
  if (Number(existing.rows[0]?.n ?? '0') === 0) {
    await tx.query(
      `INSERT INTO city_pricing
         (city_id, base_cents, per_km_cents, per_minute_cents, minimum_cents,
          service_fee_cents, round_to_cents, cancellation_fee_cents, cancellation_grace_seconds)
       VALUES ($1, 6000, 2800, 400, 11000, 0, 500, 8000, 120)`,
      [city.id],
    );
  }
  return { cityId: city.id };
}

async function seedPlans(tx: Queryable, cityId: string): Promise<Map<string, string>> {
  // commission_bps: free 12 %, pro 2 %, plus 0 % — tal como los propusiste.
  // El modelo financiero muestra por qué pro y plus necesitan revisión.
  const plans = [
    { code: 'free', name: 'Free',  fee: 0,      bps: 1200 },
    { code: 'pro',  name: 'Pro',   fee: 280_000, bps: 200 },
    { code: 'plus', name: 'Plus',  fee: 600_000, bps: 0 },
  ];
  const ids = new Map<string, string>();
  for (const p of plans) {
    const found = await tx.query<{ id: string }>(
      `SELECT id FROM plans WHERE city_id = $1 AND code = $2 ORDER BY effective_from DESC LIMIT 1`,
      [cityId, p.code],
    );
    const existing = found.rows[0];
    if (existing) {
      ids.set(p.code, existing.id);
      continue;
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO plans (city_id, code, name, monthly_fee_cents, commission_bps)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [cityId, p.code, p.name, p.fee, p.bps],
    );
    const row = rows[0];
    if (!row) throw new Error(`no se pudo crear el plan ${p.code}`);
    ids.set(p.code, row.id);
  }
  return ids;
}

async function upsertUser(
  tx: Queryable, phone: string, name: string, role: 'rider' | 'driver' | 'admin', cityId: string,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO users (phone_e164, full_name, role, city_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone_e164) DO UPDATE SET full_name = EXCLUDED.full_name, city_id = EXCLUDED.city_id
     RETURNING id`,
    [phone, name, role, cityId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no se pudo crear el usuario ${phone}`);
  return row.id;
}

async function seedDriver(
  tx: Queryable, cityId: string, planIds: Map<string, string>, d: SeedDriver,
): Promise<void> {
  const userId = await upsertUser(tx, d.phone, d.name, 'driver', cityId);

  await tx.query(
    `INSERT INTO drivers (user_id, onboarding_status, rating_avg, rating_count,
                          acceptance_rate, cancellation_rate, approved_at)
     VALUES ($1, 'approved', 4.85, 120, 0.82, 0.03, now())
     ON CONFLICT (user_id) DO UPDATE SET onboarding_status = 'approved', approved_at = now()`,
    [userId],
  );

  // Documentos obligatorios aprobados y sin vencer: si no, el dispatch los filtra.
  for (const kind of ['license', 'vehicle_registration', 'insurance'] as const) {
    const found = await tx.query<{ id: string }>(
      `SELECT id FROM driver_documents WHERE driver_id = $1 AND kind = $2 LIMIT 1`,
      [userId, kind],
    );
    if (found.rows[0]) continue;
    await tx.query(
      `INSERT INTO driver_documents (driver_id, kind, storage_key, expires_at, status, reviewed_at)
       VALUES ($1, $2, $3, CURRENT_DATE + INTERVAL '1 year', 'approved', now())`,
      [userId, kind, `seed/${userId}/${kind}.jpg`],
    );
  }

  await tx.query(
    `INSERT INTO vehicles (driver_id, plate, make, model, year, color, category, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, 'standard', TRUE)
     ON CONFLICT (driver_id, plate) DO UPDATE SET is_active = TRUE`,
    [userId, d.plate, d.make, d.model, d.year, d.color],
  );

  const planId = planIds.get(d.plan);
  if (!planId) throw new Error(`falta el plan ${d.plan}`);
  const hasSub = await tx.query<{ id: string }>(
    `SELECT id FROM subscriptions WHERE driver_id = $1
       AND status IN ('trialing','active','past_due') LIMIT 1`,
    [userId],
  );
  if (!hasSub.rows[0]) {
    await tx.query(
      `INSERT INTO subscriptions (driver_id, plan_id, status, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', now(), now() + INTERVAL '30 days')`,
      [userId, planId],
    );
  }

  /**
   * Última posición conocida, para que el admin vea algo antes del primer ping.
   *
   * OJO al depurar: esta tabla es un SNAPSHOT, no la fuente del dispatch. El
   * dispatch busca en el índice geo de Redis, que tiene TTL de 30 s y que el
   * seed no toca. Un conductor puede aparecer acá con `is_online = true` y no
   * existir para el dispatch, lo que hace que un NO_DRIVERS parezca inexplicable.
   *
   * Por eso se guarda con is_online = FALSE: es más honesto que mostrar online a
   * alguien que no puede recibir viajes.
   */
  await tx.query(
    `INSERT INTO driver_last_position (driver_id, position, bearing, is_online)
     VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 0, FALSE)
     ON CONFLICT (driver_id) DO UPDATE
        SET position = EXCLUDED.position, is_online = FALSE`,
    [userId, d.lng, d.lat],
  );
}

async function main(): Promise<void> {
  await withTransaction(async (tx) => {
    const { cityId } = await seedCity(tx);
    const planIds = await seedPlans(tx, cityId);

    await upsertUser(tx, '+59899100001', 'Gastón Delgado', 'rider', cityId);
    await upsertUser(tx, '+59899100000', 'Admin Orbit', 'admin', cityId);
    for (const d of DRIVERS) await seedDriver(tx, cityId, planIds, d);

    logger.info({ cityId, drivers: DRIVERS.length }, 'seed completo');
  });

  console.log(`
─────────────────────────────────────────────────────────────
  Datos de prueba listos. Teléfonos para /v1/auth/dev-login:

    Pasajero    +59899100001   (Gastón Delgado)
    Admin       +59899100000   (Admin Orbit)
    Conductor   +59899774019   (Adrián Pereda · plan Pro,  2 %)
    Conductor   +59899100002   (Marcela Giles · plan Free, 12 %)
    Conductor   +59899100003   (Rodrigo Ferrer · plan Free, 12 %)

  Los conductores arrancan OFFLINE. Para que reciban ofertas hay
  que ponerlos online con POST /v1/driver/position {isOnline:true}.
─────────────────────────────────────────────────────────────
`);
  await pool.end();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'el seed falló');
  process.exit(1);
});
