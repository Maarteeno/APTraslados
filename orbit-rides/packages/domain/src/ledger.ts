/**
 * Ledger de doble entrada.
 *
 * Toda operación de dinero es una transacción cuyas patas suman exactamente 0.
 * Se valida al construirla, no al leerla: un asiento desbalanceado no llega a
 * existir. Reconstruir plata a posteriori es imposible, así que esto se hace
 * bien desde el primer peso o no se hace.
 *
 * Signo: positivo = debe, negativo = haber.
 */

import { assertCents, type Cents, type CurrencyCode } from './money.js';

export class LedgerError extends Error {}

export const ACCOUNT_KINDS = [
  'driver_balance',
  'rider_wallet',
  'platform_revenue',
  'psp_clearing',
  'cash_in_transit',
  'promo_liability',
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export type RefType = 'trip' | 'subscription' | 'payout' | 'adjustment' | 'cancellation_fee';

export interface LedgerLine {
  readonly accountKind: AccountKind;
  /** null para cuentas de la plataforma. */
  readonly ownerId: string | null;
  readonly amountCents: Cents;
}

export interface LedgerTransaction {
  readonly transactionId: string;
  readonly refType: RefType;
  readonly refId: string;
  readonly currency: CurrencyCode;
  readonly idempotencyKey: string;
  readonly lines: readonly LedgerLine[];
  readonly createdAt: Date;
}

export interface BuildTransactionInput {
  readonly transactionId: string;
  readonly refType: RefType;
  readonly refId: string;
  readonly currency: CurrencyCode;
  readonly idempotencyKey: string;
  readonly lines: readonly LedgerLine[];
  readonly createdAt?: Date;
}

/**
 * Único constructor de transacciones. Valida la invariante de suma cero.
 * Si alguna vez esto lanza en producción, hay un bug de dinero y querés saberlo
 * en el momento, no en el cierre de mes.
 */
export function buildTransaction(input: BuildTransactionInput): LedgerTransaction {
  if (!input.idempotencyKey) {
    throw new LedgerError('idempotencyKey es obligatoria: la red móvil duplica requests');
  }
  if (input.lines.length < 2) {
    throw new LedgerError(`una transacción necesita al menos 2 patas, recibí ${input.lines.length}`);
  }
  let sum = 0;
  for (const line of input.lines) {
    assertCents(line.amountCents, `pata ${line.accountKind}`);
    if (line.amountCents === 0) {
      throw new LedgerError(`pata en 0 en ${line.accountKind}: no aporta nada, probablemente es un bug`);
    }
    sum += line.amountCents;
  }
  if (sum !== 0) {
    throw new LedgerError(
      `transacción desbalanceada: las patas suman ${sum}, deben sumar 0. ` +
        input.lines.map((l) => `${l.accountKind}=${l.amountCents}`).join(' '),
    );
  }
  return {
    transactionId: input.transactionId,
    refType: input.refType,
    refId: input.refId,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    lines: input.lines,
    createdAt: input.createdAt ?? new Date(),
  };
}

/** Verificación independiente, para usar en tests y en un job de conciliación. */
export function isBalanced(tx: LedgerTransaction): boolean {
  return tx.lines.reduce((acc, l) => acc + l.amountCents, 0) === 0;
}

// ───────────────────────── Asientos concretos ─────────────────────────────────

export interface TripSettlementInput {
  readonly transactionId: string;
  readonly tripId: string;
  readonly driverId: string;
  readonly currency: CurrencyCode;
  readonly fareCents: Cents;
  readonly commissionCents: Cents;
  readonly paymentMethod: 'cash' | 'card' | 'wallet';
  readonly createdAt?: Date;
}

/**
 * Liquidación de un viaje.
 *
 * Con tarjeta o wallet la plata entra a la plataforma: se le debe al conductor
 * su parte. Con efectivo la plata la cobró el conductor, así que la comisión
 * queda a favor nuestro y contra su balance — se descuenta del payout siguiente.
 */
export function buildTripSettlement(input: TripSettlementInput): LedgerTransaction {
  assertCents(input.fareCents, 'fareCents');
  assertCents(input.commissionCents, 'commissionCents');
  if (input.commissionCents > input.fareCents) {
    throw new LedgerError('la comisión no puede superar la tarifa');
  }
  const driverEarnings = input.fareCents - input.commissionCents;
  const lines: LedgerLine[] = [];

  if (input.paymentMethod === 'cash') {
    // El conductor cobró la tarifa completa de la mano del pasajero, así que
    // nos DEBE la comisión.
    //
    // Los signos importan y son fáciles de invertir:
    //
    //   driver_balance es una cuenta de PASIVO desde nuestra perspectiva: en
    //   negativo significa "le debemos al conductor". Si el conductor nos debe,
    //   se DEBITA el pasivo → positivo.
    //
    //   platform_revenue se ACREDITA cuando se gana → negativo. Siempre, sin
    //   importar el medio de pago.
    //
    // Estos dos signos estaban invertidos. La transacción sumaba cero igual, así
    // que el chequeo de integridad la aprobaba: la invariante de suma cero es
    // necesaria pero NO detecta una inversión donde ambas patas se dan vuelta.
    if (input.commissionCents === 0) {
      throw new LedgerError('viaje en efectivo con comisión 0: no hay nada que asentar');
    }
    lines.push({ accountKind: 'driver_balance', ownerId: input.driverId, amountCents: input.commissionCents });
    lines.push({ accountKind: 'platform_revenue', ownerId: null, amountCents: -input.commissionCents });
  } else {
    const clearing = input.paymentMethod === 'card' ? 'psp_clearing' : 'rider_wallet';
    lines.push({ accountKind: clearing, ownerId: null, amountCents: input.fareCents });
    if (driverEarnings !== 0) {
      lines.push({ accountKind: 'driver_balance', ownerId: input.driverId, amountCents: -driverEarnings });
    }
    if (input.commissionCents !== 0) {
      lines.push({ accountKind: 'platform_revenue', ownerId: null, amountCents: -input.commissionCents });
    }
  }

  return buildTransaction({
    transactionId: input.transactionId,
    refType: 'trip',
    refId: input.tripId,
    currency: input.currency,
    idempotencyKey: `trip:${input.tripId}:settlement`,
    lines,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
}

export interface SubscriptionChargeInput {
  readonly transactionId: string;
  readonly subscriptionId: string;
  readonly periodStart: string;
  readonly currency: CurrencyCode;
  readonly amountCents: Cents;
  readonly createdAt?: Date;
}

export function buildSubscriptionCharge(input: SubscriptionChargeInput): LedgerTransaction {
  if (input.amountCents <= 0) throw new LedgerError('el cargo de suscripción debe ser positivo');
  return buildTransaction({
    transactionId: input.transactionId,
    refType: 'subscription',
    refId: input.subscriptionId,
    currency: input.currency,
    idempotencyKey: `subscription:${input.subscriptionId}:${input.periodStart}`,
    lines: [
      { accountKind: 'psp_clearing', ownerId: null, amountCents: input.amountCents },
      { accountKind: 'platform_revenue', ownerId: null, amountCents: -input.amountCents },
    ],
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
}

export interface PayoutInput {
  readonly transactionId: string;
  readonly payoutId: string;
  readonly driverId: string;
  readonly currency: CurrencyCode;
  readonly amountCents: Cents;
  readonly createdAt?: Date;
}

export function buildPayout(input: PayoutInput): LedgerTransaction {
  if (input.amountCents <= 0) throw new LedgerError('el payout debe ser positivo');
  return buildTransaction({
    transactionId: input.transactionId,
    refType: 'payout',
    refId: input.payoutId,
    currency: input.currency,
    idempotencyKey: `payout:${input.payoutId}`,
    lines: [
      { accountKind: 'driver_balance', ownerId: input.driverId, amountCents: input.amountCents },
      { accountKind: 'psp_clearing', ownerId: null, amountCents: -input.amountCents },
    ],
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
}

/**
 * Ingreso de la plataforma en una transacción, en positivo.
 *
 * Existe para poder testear la DIRECCIÓN de los asientos y no solo que sumen
 * cero. Un ingreso ganado siempre se acredita (pata negativa); si esto devuelve
 * un número negativo, hay una inversión de signo.
 */
export function platformRevenueEarnedCents(tx: LedgerTransaction): Cents {
  return -tx.lines
    .filter((l) => l.accountKind === 'platform_revenue')
    .reduce((acc, l) => acc + l.amountCents, 0);
}

/**
 * Cuánto le debemos al conductor (positivo) o cuánto nos debe él (negativo).
 * Traduce el signo contable a algo que se pueda mostrar sin ambigüedad.
 */
export function driverOwedCents(lines: readonly LedgerLine[], driverId: string): Cents {
  return -accountBalance(lines, 'driver_balance', driverId);
}

/** Saldo de una cuenta a partir de sus patas. El ledger es la fuente; esto es una proyección. */
export function accountBalance(lines: readonly LedgerLine[], kind: AccountKind, ownerId: string | null): Cents {
  return lines
    .filter((l) => l.accountKind === kind && l.ownerId === ownerId)
    .reduce((acc, l) => acc + l.amountCents, 0);
}
