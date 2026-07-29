import { describe, it, expect } from 'vitest';
import { assertCents, roundHalfEven, applyBasisPoints, sumCents, MoneyError } from '../src/money.js';

describe('money', () => {
  it('rechaza montos no enteros: los centavos fraccionarios son el origen de todo descalce', () => {
    expect(() => assertCents(10.5)).toThrow(MoneyError);
    expect(() => assertCents(NaN)).toThrow(MoneyError);
    expect(() => assertCents(Infinity)).toThrow(MoneyError);
  });

  it('redondea half-even (bancario), no half-up', () => {
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(4.5)).toBe(4);
    expect(roundHalfEven(2.4)).toBe(2);
    expect(roundHalfEven(2.6)).toBe(3);
  });

  it('el sesgo del half-even es menor que el del half-up sobre muchas operaciones', () => {
    let even = 0;
    let up = 0;
    for (let i = 0; i < 1000; i++) {
      const v = i + 0.5;
      even += roundHalfEven(v) - v;
      up += Math.round(v) - v;
    }
    expect(Math.abs(even)).toBeLessThan(Math.abs(up));
  });

  it('aplica basis points con validación de rango', () => {
    expect(applyBasisPoints(50_000, 1200)).toBe(6000); // 12 % de 500,00
    expect(applyBasisPoints(50_000, 200)).toBe(1000);  // 2 %
    expect(applyBasisPoints(50_000, 0)).toBe(0);
    expect(() => applyBasisPoints(50_000, 10_001)).toThrow(MoneyError);
    expect(() => applyBasisPoints(50_000, -1)).toThrow(MoneyError);
  });

  it('suma validando cada término', () => {
    expect(sumCents(100, 200, -50)).toBe(250);
    expect(() => sumCents(100, 0.5)).toThrow(MoneyError);
  });
});
