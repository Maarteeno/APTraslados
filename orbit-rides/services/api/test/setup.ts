/**
 * Entorno de tests.
 *
 * La configuración se valida al importarse (`loadConfig()` a nivel de módulo en
 * logger y en el pool). Eso es intencional: el servicio no arranca con
 * configuración incompleta. La contrapartida es que los tests necesitan un
 * entorno mínimo ANTES de importar cualquier módulo del servicio, y para eso
 * está este archivo, declarado en `setupFiles` de vitest.
 *
 * Los valores apuntan a hosts locales que los tests unitarios nunca tocan: no
 * hay conexión real a Postgres ni a Redis en esta suite.
 */

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] ??= 'silent';
process.env['DATABASE_URL'] ??= 'postgres://orbit:orbit@localhost:5432/orbit_test';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['QUOTE_SIGNING_SECRET'] ??= 'test_quote_secret_0123456789abcdef0123456789';
process.env['AUTH_DEV_SECRET'] ??= 'test_auth_secret_0123456789abcdef0123456789';
process.env['AUTH_MODE'] ??= 'dev';
