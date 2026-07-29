/**
 * Dinero. Siempre enteros en centavos de la moneda de la ciudad.
 *
 * Nunca float: 0.1 + 0.2 !== 0.3, y en un ledger eso se acumula hasta que
 * la contabilidad no cierra y no hay forma de reconstruir por qué.
 */

export type Cents = number;
export type CurrencyCode = 'UYU' | 'USD' | 'ARS' | 'BRL';

export class MoneyError extends Error {}

/** Valida que un valor sea un monto usable: entero y finito. */
export function assertCents(value: number, label = 'monto'): Cents {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`${label}: debe ser finito, recibí ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label}: debe ser un entero en centavos, recibí ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label}: excede el entero seguro de JS (${value})`);
  }
  return value;
}

export function assertNonNegative(value: number, label = 'monto'): Cents {
  assertCents(value, label);
  if (value < 0) throw new MoneyError(`${label}: no puede ser negativo, recibí ${value}`);
  return value;
}

/**
 * Redondeo bancario (half-even). Para comisiones es el estándar contable:
 * el half-up sesga sistemáticamente a favor de una de las partes, y sobre
 * cientos de miles de viajes esa diferencia es real y auditable.
 *
 *   roundHalfEven(2.5) === 2      roundHalfEven(3.5) === 4
 */
export function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) throw new MoneyError(`no se puede redondear ${value}`);
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Aplica una tasa en basis points (1 bp = 0,01 %) a un monto. */
export function applyBasisPoints(amount: Cents, bps: number): Cents {
  assertCents(amount, 'amount');
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new MoneyError(`bps fuera de rango [0,10000]: ${bps}`);
  }
  return roundHalfEven((amount * bps) / 10_000);
}

/** Suma segura: valida cada término y el total. */
export function sumCents(...values: Cents[]): Cents {
  let total = 0;
  for (const v of values) total += assertCents(v);
  return assertCents(total, 'total');
}

/** Formato legible. No usar para cálculos. */
export function formatCents(amount: Cents, currency: CurrencyCode, locale = 'es-UY'): string {
  assertCents(amount);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount / 100);
}
