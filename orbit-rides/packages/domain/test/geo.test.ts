import { describe, it, expect } from 'vitest';
import { haversineMeters, bearingDegrees, interpolate, GeoError } from '../src/geo.js';

const POCITOS = { lat: -34.9112, lng: -56.1553 };
const CIUDAD_VIEJA = { lat: -34.9066, lng: -56.2044 };

describe('geo', () => {
  it('mide una distancia conocida de Montevideo con error menor al 2 %', () => {
    const d = haversineMeters(POCITOS, CIUDAD_VIEJA);
    expect(d).toBeGreaterThan(4400);
    expect(d).toBeLessThan(4600);
  });

  it('distancia a sí mismo es 0 y es simétrica', () => {
    expect(haversineMeters(POCITOS, POCITOS)).toBe(0);
    expect(haversineMeters(POCITOS, CIUDAD_VIEJA)).toBeCloseTo(haversineMeters(CIUDAD_VIEJA, POCITOS), 6);
  });

  it('el rumbo hacia el oeste está cerca de 270°', () => {
    const b = bearingDegrees(POCITOS, CIUDAD_VIEJA);
    expect(b).toBeGreaterThan(255);
    expect(b).toBeLessThan(285);
  });

  it('interpola y satura fuera de [0,1]', () => {
    const mid = interpolate(POCITOS, CIUDAD_VIEJA, 0.5);
    expect(mid.lat).toBeCloseTo((POCITOS.lat + CIUDAD_VIEJA.lat) / 2, 9);
    expect(interpolate(POCITOS, CIUDAD_VIEJA, -3)).toEqual(POCITOS);
    expect(interpolate(POCITOS, CIUDAD_VIEJA, 7)).toEqual(CIUDAD_VIEJA);
  });

  it('rechaza coordenadas inválidas', () => {
    expect(() => haversineMeters({ lat: 100, lng: 0 }, POCITOS)).toThrow(GeoError);
    expect(() => haversineMeters({ lat: 0, lng: 200 }, POCITOS)).toThrow(GeoError);
    expect(() => haversineMeters({ lat: NaN, lng: 0 }, POCITOS)).toThrow(GeoError);
  });
});
