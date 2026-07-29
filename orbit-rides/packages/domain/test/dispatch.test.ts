import { describe, it, expect } from 'vitest';
import {
  planWave, filterEligible, scoreCandidates, DEFAULT_DISPATCH_CONFIG,
  assertDispatchConfig, DispatchError, type DriverCandidate, type DispatchConfig,
} from '../src/dispatch.js';
import type { LatLng } from '../src/geo.js';

const ORIGIN: LatLng = { lat: -34.9112, lng: -56.1553 }; // Pocitos

/** Desplaza un punto ~metros hacia el norte. 1° lat ≈ 111.320 m */
function north(p: LatLng, meters: number): LatLng {
  return { lat: p.lat + meters / 111_320, lng: p.lng };
}

function driver(id: string, over: Partial<DriverCandidate> = {}): DriverCandidate {
  return {
    driverId: id,
    position: north(ORIGIN, 500),
    ratingAvg: 4.8,
    acceptanceRate: 0.8,
    cancellationRate: 0.02,
    idleMinutes: 5,
    vehicleCategory: 'standard',
    onboardingApproved: true,
    subscriptionActive: true,
    documentsValid: true,
    hasActiveTrip: false,
    ...over,
  };
}

describe('filtro de elegibilidad', () => {
  it('excluye y explica el motivo de cada exclusión', () => {
    const r = filterEligible(
      [
        driver('ok'),
        driver('sin_onboarding', { onboardingApproved: false }),
        driver('sin_sub', { subscriptionActive: false }),
        driver('docs', { documentsValid: false }),
        driver('ocupado', { hasActiveTrip: true }),
        driver('categoria', { vehicleCategory: 'van' }),
        driver('lejos', { position: north(ORIGIN, 20_000) }),
      ],
      ORIGIN, 3000, DEFAULT_DISPATCH_CONFIG,
    );
    expect(r.eligible.map((d) => d.driverId)).toEqual(['ok']);
    const byId = Object.fromEntries(r.rejected.map((x) => [x.driverId, x.reason]));
    expect(byId['sin_onboarding']).toBe('onboarding_pending');
    expect(byId['sin_sub']).toBe('subscription_inactive');
    expect(byId['docs']).toBe('documents_invalid');
    expect(byId['ocupado']).toBe('already_on_trip');
    expect(byId['categoria']).toBe('category_mismatch');
    expect(byId['lejos']).toBe('out_of_radius');
  });

  it('no vuelve a ofertar a quien ya recibió oferta en una ola anterior', () => {
    const r = filterEligible([driver('a'), driver('b')], ORIGIN, 3000, DEFAULT_DISPATCH_CONFIG, new Set(['a']));
    expect(r.eligible.map((d) => d.driverId)).toEqual(['b']);
    expect(r.rejected[0]?.reason).toBe('already_offered');
  });
});

describe('scoring', () => {
  it('prefiere al más cercano cuando todo lo demás es igual', () => {
    const s = scoreCandidates(
      [driver('lejos', { position: north(ORIGIN, 2500) }), driver('cerca', { position: north(ORIGIN, 300) })],
      ORIGIN, DEFAULT_DISPATCH_CONFIG,
    );
    expect(s[0]?.candidate.driverId).toBe('cerca');
  });

  it('penaliza al que cancela mucho aunque esté más cerca', () => {
    const s = scoreCandidates(
      [
        driver('cancelador', { position: north(ORIGIN, 300), cancellationRate: 0.5 }),
        driver('confiable', { position: north(ORIGIN, 900), cancellationRate: 0.0 }),
      ],
      ORIGIN, DEFAULT_DISPATCH_CONFIG,
    );
    expect(s[0]?.candidate.driverId).toBe('confiable');
  });

  it('el término de equidad favorece a quien esperó más, a igual distancia', () => {
    const s = scoreCandidates(
      [driver('recien', { idleMinutes: 0 }), driver('esperando', { idleMinutes: 40 })],
      ORIGIN, DEFAULT_DISPATCH_CONFIG,
    );
    expect(s[0]?.candidate.driverId).toBe('esperando');
  });

  it('el orden es estable y reproducible ante empate', () => {
    const a = driver('zzz');
    const b = driver('aaa');
    const s1 = scoreCandidates([a, b], ORIGIN, DEFAULT_DISPATCH_CONFIG);
    const s2 = scoreCandidates([b, a], ORIGIN, DEFAULT_DISPATCH_CONFIG);
    expect(s1.map((x) => x.candidate.driverId)).toEqual(s2.map((x) => x.candidate.driverId));
    expect(s1[0]?.candidate.driverId).toBe('aaa');
  });

  it('el ETA nunca baja de 30 s, para no prometer imposibles', () => {
    const s = scoreCandidates([driver('encima', { position: ORIGIN })], ORIGIN, DEFAULT_DISPATCH_CONFIG);
    expect(s[0]?.etaSeconds).toBe(30);
  });
});

describe('planificación de olas', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    driver(`d${String(i).padStart(2, '0')}`, { position: north(ORIGIN, 200 + i * 400) }),
  );

  it('la ola 1 oferta a los 3 mejores dentro de 3 km', () => {
    const w = planWave(1, many, ORIGIN, DEFAULT_DISPATCH_CONFIG);
    expect(w).not.toBeNull();
    expect(w?.wave).toBe(1);
    expect(w?.radiusMeters).toBe(3000);
    expect(w?.offers).toHaveLength(3);
    expect(w?.expiresInSeconds).toBe(15);
  });

  it('la ola 2 amplía el radio y no repite a los de la ola 1', () => {
    const w1 = planWave(1, many, ORIGIN, DEFAULT_DISPATCH_CONFIG);
    const offered = new Set(w1?.offers.map((o) => o.candidate.driverId));
    const w2 = planWave(2, many, ORIGIN, DEFAULT_DISPATCH_CONFIG, offered);
    expect(w2?.radiusMeters).toBe(5000);
    for (const o of w2?.offers ?? []) {
      expect(offered.has(o.candidate.driverId)).toBe(false);
    }
  });

  it('devuelve null cuando se agotan las olas: eso es NO_DRIVERS', () => {
    expect(planWave(4, many, ORIGIN, DEFAULT_DISPATCH_CONFIG)).toBeNull();
  });

  it('devuelve null si no hay ningún candidato elegible', () => {
    expect(planWave(1, [driver('x', { hasActiveTrip: true })], ORIGIN, DEFAULT_DISPATCH_CONFIG)).toBeNull();
    expect(planWave(1, [], ORIGIN, DEFAULT_DISPATCH_CONFIG)).toBeNull();
  });

  it('ningún conductor recibe dos ofertas del mismo viaje en olas distintas', () => {
    const seen = new Set<string>();
    for (let wave = 1; wave <= DEFAULT_DISPATCH_CONFIG.waveRadiiMeters.length; wave++) {
      const w = planWave(wave, many, ORIGIN, DEFAULT_DISPATCH_CONFIG, seen);
      for (const o of w?.offers ?? []) {
        expect(seen.has(o.candidate.driverId)).toBe(false);
        seen.add(o.candidate.driverId);
      }
    }
  });

  it('valida la configuración', () => {
    const bad: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG, waveSizes: [3] };
    expect(() => assertDispatchConfig(bad)).toThrow(DispatchError);
    expect(() => planWave(0, many, ORIGIN, DEFAULT_DISPATCH_CONFIG)).toThrow(DispatchError);
  });
});
