/**
 * Configuración. Se valida al arrancar y falla ruidosamente si algo falta.
 *
 * Un servicio que arranca con configuración incompleta y explota recién cuando
 * llega el primer request es mucho peor que uno que no arranca.
 */

import { z } from 'zod';

const csvNumbers = (label: string) =>
  z.string().transform((raw, ctx) => {
    const parts = raw.split(',').map((s) => Number(s.trim()));
    if (parts.some((n) => !Number.isFinite(n) || n <= 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label}: lista de números positivos separados por coma` });
      return z.NEVER;
    }
    return parts;
  });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  // 'silent' es un nivel válido de pino y lo usamos en tests.
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Formato de log legible por humanos. Requiere pino-pretty, que es una
  // devDependency: dentro de un contenedor esto va en false y los logs salen
  // en JSON, que es lo que un colector espera. Antes esto se decidía por
  // NODE_ENV y el servicio crasheaba al arrancar con NODE_ENV=development en
  // una imagen sin devDependencies.
  LOG_PRETTY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().url(),

  QUOTE_SIGNING_SECRET: z.string().min(32, 'el secreto de firma necesita 32+ caracteres'),
  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  AUTH_MODE: z.enum(['dev', 'firebase']).default('dev'),
  AUTH_DEV_SECRET: z.string().min(32),
  AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  FIREBASE_PROJECT_ID: z.string().optional(),

  DISPATCH_OFFER_TTL_SECONDS: z.coerce.number().int().positive().default(15),
  DISPATCH_WAVE_RADII_M: csvNumbers('DISPATCH_WAVE_RADII_M').default('3000,5000,8000'),
  DISPATCH_WAVE_SIZES: csvNumbers('DISPATCH_WAVE_SIZES').default('3,5,5'),
  DRIVER_POSITION_TTL_SECONDS: z.coerce.number().int().positive().default(30),

  CORS_ORIGINS: z.string().default('*'),

  /**
   * Ruteo. Opcional: sin proveedor, el API usa una estimación local y lo
   * declara en `routeProvider`, así un ETA estimado nunca se confunde con uno
   * real.
   *
   * OSRM_URL apunta a un OSRM autohospedado (gratis, sin cuota).
   * MAPBOX_TOKEN es la alternativa comercial. Si están los dos, gana OSRM.
   */
  OSRM_URL: z.string().url().optional(),
  MAPBOX_TOKEN: z.string().min(1).optional(),
  ROUTING_TIMEOUT_MS: z.coerce.number().int().positive().default(3500),
});

export type Config = z.infer<typeof schema> & { readonly isProduction: boolean };

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${detail}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (parsed.data.AUTH_MODE === 'dev') {
      throw new Error('AUTH_MODE=dev no se permite en producción: usá firebase');
    }
    for (const [k, v] of Object.entries({
      QUOTE_SIGNING_SECRET: parsed.data.QUOTE_SIGNING_SECRET,
      AUTH_DEV_SECRET: parsed.data.AUTH_DEV_SECRET,
    })) {
      if (v.includes('cambiame')) throw new Error(`${k} sigue con el valor de ejemplo`);
    }
  }
  if (parsed.data.DISPATCH_WAVE_RADII_M.length !== parsed.data.DISPATCH_WAVE_SIZES.length) {
    throw new Error('DISPATCH_WAVE_RADII_M y DISPATCH_WAVE_SIZES deben tener el mismo largo');
  }
  cached = { ...parsed.data, isProduction: parsed.data.NODE_ENV === 'production' };
  return cached;
}

/** Solo para tests. */
export function resetConfig(): void {
  cached = null;
}
