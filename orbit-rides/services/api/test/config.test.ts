import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, resetConfig } from '../src/config/index.js';

const BASE = {
  DATABASE_URL: 'postgres://orbit:orbit@localhost:5432/orbit',
  REDIS_URL: 'redis://localhost:6379',
  QUOTE_SIGNING_SECRET: 'q'.repeat(48),
  AUTH_DEV_SECRET: 'a'.repeat(48),
};

describe('validación de configuración', () => {
  beforeEach(() => resetConfig());

  it('carga con lo mínimo y aplica defaults', () => {
    const c = loadConfig({ ...BASE } as NodeJS.ProcessEnv);
    expect(c.PORT).toBe(8080);
    expect(c.AUTH_MODE).toBe('dev');
    expect(c.DISPATCH_WAVE_RADII_M).toEqual([3000, 5000, 8000]);
    expect(c.DISPATCH_WAVE_SIZES).toEqual([3, 5, 5]);
    expect(c.isProduction).toBe(false);
  });

  it('rechaza un secreto de firma corto: es la defensa de la tarifa', () => {
    expect(() => loadConfig({ ...BASE, QUOTE_SIGNING_SECRET: 'corto' } as NodeJS.ProcessEnv)).toThrow(/32/);
  });

  it('rechaza una DATABASE_URL que no es URL', () => {
    expect(() => loadConfig({ ...BASE, DATABASE_URL: 'localhost' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('NO permite AUTH_MODE=dev en producción', () => {
    expect(() =>
      loadConfig({ ...BASE, NODE_ENV: 'production', AUTH_MODE: 'dev' } as NodeJS.ProcessEnv),
    ).toThrow(/no se permite en producción/);
  });

  it('en producción rechaza los secretos de ejemplo sin cambiar', () => {
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'production',
        AUTH_MODE: 'firebase',
        QUOTE_SIGNING_SECRET: 'cambiame_en_produccion_0123456789abcdef01',
      } as NodeJS.ProcessEnv),
    ).toThrow(/sigue con el valor de ejemplo/);
  });

  it('exige que radios y tamaños de ola tengan el mismo largo', () => {
    expect(() =>
      loadConfig({
        ...BASE,
        DISPATCH_WAVE_RADII_M: '3000,5000,8000',
        DISPATCH_WAVE_SIZES: '3,5',
      } as NodeJS.ProcessEnv),
    ).toThrow(/mismo largo/);
  });

  it('rechaza radios no numéricos', () => {
    expect(() =>
      loadConfig({ ...BASE, DISPATCH_WAVE_RADII_M: '3000,abc,8000' } as NodeJS.ProcessEnv),
    ).toThrow(/números positivos/);
  });
});
