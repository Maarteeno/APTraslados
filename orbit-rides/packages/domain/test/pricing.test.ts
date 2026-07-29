import { describe, it, expect } from 'vitest';
import {
  computeFare, signQuote, verifyQuote, PricingError,
  QuoteInvalidError, QuoteExpiredError,
  type PricingParams, type QuotePayload,
} from '../src/pricing.js';

const MVD: PricingParams = {
  currency: 'UYU',
  baseCents: 6000,        // $ 60
  perKmCents: 2800,       // $ 28 / km
  perMinuteCents: 400,    // $ 4 / min
  minimumCents: 11_000,   // $ 110
  serviceFeeCents: 0,
  roundToCents: 500,      // redondeo a $ 5
};

const SECRET = 'a'.repeat(48);

describe('computeFare', () => {
  it('calcula base + distancia + tiempo', () => {
    const f = computeFare({ distanceMeters: 5000, durationSeconds: 900 }, MVD);
    expect(f.distanceCents).toBe(14_000); // 5 km × 28
    expect(f.timeCents).toBe(6000);       // 15 min × 4
    expect(f.subtotalCents).toBe(26_000);
    expect(f.totalCents).toBe(26_000);
  });

  it('aplica la tarifa mínima en viajes cortos', () => {
    const f = computeFare({ distanceMeters: 400, durationSeconds: 120 }, MVD);
    expect(f.subtotalCents).toBeLessThan(MVD.minimumCents);
    expect(f.minimumAppliedCents).toBeGreaterThan(0);
    expect(f.totalCents).toBe(MVD.minimumCents);
  });

  it('el surge multiplica el viaje pero no el fee de servicio', () => {
    const withFee: PricingParams = { ...MVD, serviceFeeCents: 2000, roundToCents: 0 };
    const plain = computeFare({ distanceMeters: 5000, durationSeconds: 900 }, withFee, 1);
    const surged = computeFare({ distanceMeters: 5000, durationSeconds: 900 }, withFee, 1.5);
    expect(plain.totalCents).toBe(26_000 + 2000);
    expect(surged.totalCents).toBe(26_000 * 1.5 + 2000);
  });

  it('el fee de servicio se suma después del mínimo, no se absorbe', () => {
    const withFee: PricingParams = { ...MVD, serviceFeeCents: 2000, roundToCents: 0 };
    const f = computeFare({ distanceMeters: 400, durationSeconds: 120 }, withFee);
    expect(f.totalCents).toBe(MVD.minimumCents + 2000);
  });

  it('redondea el total al múltiplo configurado', () => {
    const f = computeFare({ distanceMeters: 5123, durationSeconds: 947 }, MVD);
    expect(f.totalCents % MVD.roundToCents).toBe(0);
  });

  it('es determinista: mismos inputs, mismo output', () => {
    const a = computeFare({ distanceMeters: 7321, durationSeconds: 1234 }, MVD, 1.3);
    const b = computeFare({ distanceMeters: 7321, durationSeconds: 1234 }, MVD, 1.3);
    expect(a).toEqual(b);
  });

  it('rechaza surge y rutas inválidas', () => {
    expect(() => computeFare({ distanceMeters: 1000, durationSeconds: 60 }, MVD, 0.5)).toThrow(PricingError);
    expect(() => computeFare({ distanceMeters: 1000, durationSeconds: 60 }, MVD, 9)).toThrow(PricingError);
    expect(() => computeFare({ distanceMeters: -1, durationSeconds: 60 }, MVD)).toThrow(PricingError);
  });
});

function payload(over: Partial<QuotePayload> = {}): QuotePayload {
  const now = 1_700_000_000_000;
  return {
    quoteId: 'qt_abc123',
    cityId: 'city_mvd',
    riderId: 'usr_1',
    origin: { lat: -34.9112, lng: -56.1553 },
    destination: { lat: -34.8721, lng: -56.1234 },
    distanceMeters: 5000,
    durationSeconds: 900,
    surgeMultiplier: 1,
    totalCents: 26_000,
    currency: 'UYU',
    issuedAt: now,
    expiresAt: now + 120_000,
    ...over,
  };
}

describe('cotización firmada — el cliente no puede alterar la tarifa', () => {
  it('firma y verifica de ida y vuelta', () => {
    const signed = signQuote(payload(), SECRET);
    const ok = verifyQuote(signed, SECRET, payload().issuedAt + 1000);
    expect(ok.totalCents).toBe(26_000);
  });

  it('detecta un monto alterado', () => {
    const signed = signQuote(payload(), SECRET);
    const tampered = { ...signed, payload: { ...signed.payload, totalCents: 100 } };
    expect(() => verifyQuote(tampered, SECRET, payload().issuedAt + 1000)).toThrow(QuoteInvalidError);
  });

  it('detecta un destino alterado', () => {
    const signed = signQuote(payload(), SECRET);
    const tampered = {
      ...signed,
      payload: { ...signed.payload, destination: { lat: -34.0, lng: -56.0 } },
    };
    expect(() => verifyQuote(tampered, SECRET, payload().issuedAt + 1000)).toThrow(QuoteInvalidError);
  });

  it('rechaza una firma de otro secreto', () => {
    const signed = signQuote(payload(), SECRET);
    expect(() => verifyQuote(signed, 'b'.repeat(48), payload().issuedAt + 1000)).toThrow(QuoteInvalidError);
  });

  it('distingue vencida de inválida: son problemas distintos', () => {
    const signed = signQuote(payload(), SECRET);
    expect(() => verifyQuote(signed, SECRET, payload().expiresAt + 1)).toThrow(QuoteExpiredError);
  });

  it('la firma no depende del orden de las claves del objeto', () => {
    const a = signQuote(payload(), SECRET);
    const reordered: QuotePayload = {
      expiresAt: a.payload.expiresAt,
      issuedAt: a.payload.issuedAt,
      currency: a.payload.currency,
      totalCents: a.payload.totalCents,
      surgeMultiplier: a.payload.surgeMultiplier,
      durationSeconds: a.payload.durationSeconds,
      distanceMeters: a.payload.distanceMeters,
      destination: a.payload.destination,
      origin: a.payload.origin,
      riderId: a.payload.riderId,
      cityId: a.payload.cityId,
      quoteId: a.payload.quoteId,
    };
    expect(signQuote(reordered, SECRET).signature).toBe(a.signature);
  });

  it('exige un secreto de largo mínimo', () => {
    expect(() => signQuote(payload(), 'corto')).toThrow(PricingError);
  });
});

/**
 * Estos tests existen por un bug de producción.
 *
 * La cotización se firmaba en memoria y después se GUARDABA en Postgres. Al
 * canjearla, el payload se RECONSTRUÍA desde las columnas normalizadas para
 * verificar el HMAC — y nunca coincidía, porque el id se generaba dos veces
 * (uno en JS para firmar, otro con gen_random_uuid() al insertar).
 *
 * Los tests de arriba no lo veían: firman y verifican el mismo objeto en
 * memoria, sin pasar nunca por serialización ni por la base. Estos cubren el
 * viaje de ida y vuelta.
 */
describe('la firma sobrevive el viaje de ida y vuelta por JSON', () => {
  it('firmar → JSON.stringify → JSON.parse → verificar', () => {
    const signed = signQuote(payload(), SECRET);
    const stored = JSON.stringify(signed.payload);

    const revived: SignedQuote = {
      payload: JSON.parse(stored) as QuotePayload,
      signature: signed.signature,
    };
    const ok = verifyQuote(revived, SECRET, payload().issuedAt + 1000);
    expect(ok.totalCents).toBe(payload().totalCents);
    expect(ok.quoteId).toBe(payload().quoteId);
  });

  it('un id distinto al firmado invalida la firma', () => {
    const signed = signQuote(payload(), SECRET);
    const tampered: SignedQuote = {
      payload: { ...signed.payload, quoteId: 'qt_otro_id' },
      signature: signed.signature,
    };
    expect(() => verifyQuote(tampered, SECRET, payload().issuedAt + 1000)).toThrow(QuoteInvalidError);
  });

  it('un issuedAt aproximado invalida la firma: no se puede deducir, hay que guardarlo', () => {
    const signed = signQuote(payload(), SECRET);
    const reconstructed: SignedQuote = {
      // Esto es exactamente lo que hacía el código roto: deducir issuedAt
      // restando el TTL a expiresAt. Con el TTL correcto da igual, pero si
      // alguien cambia la config, se rompe en silencio.
      payload: { ...signed.payload, issuedAt: signed.payload.expiresAt - 90_000 },
      signature: signed.signature,
    };
    expect(() => verifyQuote(reconstructed, SECRET, payload().issuedAt + 1000)).toThrow(QuoteInvalidError);
  });

  it('las coordenadas sobreviven el round-trip con precisión exacta', () => {
    const precise = payload({
      origin: { lat: -34.91123456789012, lng: -56.15534567890123 },
      destination: { lat: -34.90661234567891, lng: -56.20441234567892 },
    });
    const signed = signQuote(precise, SECRET);
    const revived: SignedQuote = {
      payload: JSON.parse(JSON.stringify(signed.payload)) as QuotePayload,
      signature: signed.signature,
    };
    expect(() => verifyQuote(revived, SECRET, precise.issuedAt + 1000)).not.toThrow();
  });

  it('un surge que vuelve como string rompe la firma', () => {
    const signed = signQuote(payload(), SECRET);
    const asString = {
      payload: { ...signed.payload, surgeMultiplier: '1.00' as unknown as number },
      signature: signed.signature,
    };
    expect(() => verifyQuote(asString, SECRET, payload().issuedAt + 1000)).toThrow(QuoteInvalidError);
  });
});
