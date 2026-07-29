import { describe, it, expect } from 'vitest';
import {
  splitFare, cardRideMarginCents, breakEvenCommissionBps, blendedBreakEvenCommissionBps,
  planIndifferenceGrossCents,
  CommissionError, type Plan, type ProcessingCost,
} from '../src/commission.js';

const FREE: Plan = { code: 'free', monthlyFeeCents: 0,        commissionBps: 1200, maxRidesPerMonth: null };
const PRO:  Plan = { code: 'pro',  monthlyFeeCents: 280_000,  commissionBps: 200,  maxRidesPerMonth: null }; // US$70 a 40 UYU
const PLUS: Plan = { code: 'plus', monthlyFeeCents: 600_000,  commissionBps: 0,    maxRidesPerMonth: null }; // US$150

// MercadoPago estimado: 3,5 % + $5. VERIFICAR antes de fijar precios.
const PROCESSING: ProcessingCost = { rateBps: 350, fixedCents: 500 };
const VARIABLE_PER_RIDE = 500; // mapas + soporte, $5

describe('splitFare', () => {
  it('nunca pierde ni inventa un centavo', () => {
    for (const bps of [0, 1, 200, 1200, 2500, 10_000]) {
      for (const fare of [1, 99, 100, 35_000, 123_457]) {
        const s = splitFare(fare, bps);
        expect(s.commissionCents + s.driverEarningsCents).toBe(fare);
        expect(s.commissionCents).toBeGreaterThanOrEqual(0);
        expect(s.driverEarningsCents).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('12 % de $350 son $42', () => {
    const s = splitFare(35_000, 1200);
    expect(s.commissionCents).toBe(4200);
    expect(s.driverEarningsCents).toBe(30_800);
  });

  it('2 % de $350 son $7', () => {
    expect(splitFare(35_000, 200).commissionCents).toBe(700);
  });

  it('rechaza bps fuera de rango', () => {
    expect(() => splitFare(35_000, -1)).toThrow(CommissionError);
    expect(() => splitFare(35_000, 10_001)).toThrow(CommissionError);
  });
});

describe('el problema del plan Pro al 2 %', () => {
  it('un viaje con tarjeta al 2 % da PÉRDIDA', () => {
    const margin = cardRideMarginCents(35_000, 200, 0, PROCESSING, VARIABLE_PER_RIDE);
    // $7 de comisión − $17,25 de procesamiento − $5 variable = −$15,25
    expect(margin).toBe(-1525);
    expect(margin).toBeLessThan(0);
  });

  it('el mismo viaje al 12 % da ganancia', () => {
    const margin = cardRideMarginCents(35_000, 1200, 0, PROCESSING, VARIABLE_PER_RIDE);
    expect(margin).toBe(1975);
    expect(margin).toBeGreaterThan(0);
  });

  it('para que un viaje CON TARJETA no pierda hace falta ~6,4 %, no 2 %', () => {
    const bps = breakEvenCommissionBps(35_000, 0, PROCESSING, VARIABLE_PER_RIDE);
    // $12,25 de procesamiento variable + $5 fijo + $5 de costos = $22,25 sobre $350
    expect(bps).toBe(636);
    expect(cardRideMarginCents(35_000, bps, 0, PROCESSING, VARIABLE_PER_RIDE)).toBeGreaterThanOrEqual(0);
    // Un punto base menos ya da pérdida: el umbral es exacto.
    expect(cardRideMarginCents(35_000, bps - 30, 0, PROCESSING, VARIABLE_PER_RIDE)).toBeLessThan(0);
  });

  it('para que el viaje PROMEDIO no pierda alcanza ~4,4 %, porque no todos pagan con tarjeta', () => {
    const blended = blendedBreakEvenCommissionBps(35_000, 0, PROCESSING, VARIABLE_PER_RIDE, 6000);
    expect(blended).toBe(439);
  });

  it('el umbral promedio es siempre menor o igual al de tarjeta, y coinciden si todos pagan con tarjeta', () => {
    const cardOnly = breakEvenCommissionBps(35_000, 0, PROCESSING, VARIABLE_PER_RIDE);
    for (const share of [0, 2500, 6000, 9000]) {
      expect(blendedBreakEvenCommissionBps(35_000, 0, PROCESSING, VARIABLE_PER_RIDE, share))
        .toBeLessThanOrEqual(cardOnly);
    }
    expect(blendedBreakEvenCommissionBps(35_000, 0, PROCESSING, VARIABLE_PER_RIDE, 10_000)).toBe(cardOnly);
  });

  it('valida el rango de la proporción de pagos con tarjeta', () => {
    expect(() => blendedBreakEvenCommissionBps(35_000, 0, PROCESSING, VARIABLE_PER_RIDE, 10_001)).toThrow(CommissionError);
    expect(() => blendedBreakEvenCommissionBps(35_000, 0, PROCESSING, VARIABLE_PER_RIDE, -1)).toThrow(CommissionError);
  });

  it('un fee de servicio al pasajero baja la comisión de equilibrio', () => {
    const sinFee = breakEvenCommissionBps(35_000, 0, PROCESSING, VARIABLE_PER_RIDE);
    const conFee = breakEvenCommissionBps(35_000, 2000, PROCESSING, VARIABLE_PER_RIDE);
    expect(conFee).toBeLessThan(sinFee);
  });

  it('con fee de $25 el plan al 2 % deja de perder por viaje', () => {
    expect(cardRideMarginCents(35_000, 200, 2500, PROCESSING, VARIABLE_PER_RIDE)).toBeGreaterThan(0);
  });
});

describe('punto de indiferencia entre planes', () => {
  it('Free → Pro conviene desde $28.000 de facturación mensual', () => {
    expect(planIndifferenceGrossCents(FREE, PRO)).toBe(2_800_000); // $28.000
  });

  it('Pro → Plus conviene desde $160.000, muy por encima de un full-time', () => {
    const be = planIndifferenceGrossCents(PRO, PLUS) as number;
    expect(be).toBe(16_000_000); // $160.000
    const fullTimeGross = 180 * 35_000; // 180 viajes × $350 = $63.000
    expect(be).toBeGreaterThan(fullTimeGross * 2);
  });

  it('devuelve null si el plan caro no baja la comisión', () => {
    const same: Plan = { ...PRO, commissionBps: FREE.commissionBps };
    expect(planIndifferenceGrossCents(FREE, same)).toBeNull();
  });
});
