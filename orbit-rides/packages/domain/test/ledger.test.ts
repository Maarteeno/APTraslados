import { describe, it, expect } from 'vitest';
import {
  buildTransaction, isBalanced, buildTripSettlement, buildSubscriptionCharge,
  buildPayout, accountBalance, platformRevenueEarnedCents, driverOwedCents,
  LedgerError, type LedgerLine, type LedgerTransaction,
} from '../src/ledger.js';
import { splitFare } from '../src/commission.js';

describe('invariante de suma cero', () => {
  it('rechaza una transacción desbalanceada', () => {
    expect(() =>
      buildTransaction({
        transactionId: 't1', refType: 'trip', refId: 'trip1', currency: 'UYU',
        idempotencyKey: 'k1',
        lines: [
          { accountKind: 'psp_clearing', ownerId: null, amountCents: 50_000 },
          { accountKind: 'platform_revenue', ownerId: null, amountCents: -40_000 },
        ],
      }),
    ).toThrow(LedgerError);
  });

  it('exige clave de idempotencia', () => {
    expect(() =>
      buildTransaction({
        transactionId: 't1', refType: 'trip', refId: 'trip1', currency: 'UYU',
        idempotencyKey: '',
        lines: [
          { accountKind: 'psp_clearing', ownerId: null, amountCents: 100 },
          { accountKind: 'platform_revenue', ownerId: null, amountCents: -100 },
        ],
      }),
    ).toThrow(LedgerError);
  });

  it('exige al menos dos patas y rechaza patas en cero', () => {
    const one: LedgerLine[] = [{ accountKind: 'psp_clearing', ownerId: null, amountCents: 0 }];
    expect(() =>
      buildTransaction({ transactionId: 't', refType: 'trip', refId: 'r', currency: 'UYU', idempotencyKey: 'k', lines: one }),
    ).toThrow(LedgerError);
    expect(() =>
      buildTransaction({
        transactionId: 't', refType: 'trip', refId: 'r', currency: 'UYU', idempotencyKey: 'k',
        lines: [
          { accountKind: 'psp_clearing', ownerId: null, amountCents: 0 },
          { accountKind: 'platform_revenue', ownerId: null, amountCents: 0 },
        ],
      }),
    ).toThrow(LedgerError);
  });
});

describe('liquidación de viaje', () => {
  const fare = 50_000; // $500
  const { commissionCents } = splitFare(fare, 500); // 5 %

  it('con tarjeta: entra al PSP, se le debe al conductor, queda la comisión', () => {
    const tx = buildTripSettlement({
      transactionId: 'tx1', tripId: 'trip1', driverId: 'drv1', currency: 'UYU',
      fareCents: fare, commissionCents, paymentMethod: 'card',
    });
    expect(isBalanced(tx)).toBe(true);
    expect(accountBalance(tx.lines, 'psp_clearing', null)).toBe(50_000);
    expect(accountBalance(tx.lines, 'driver_balance', 'drv1')).toBe(-47_500);
    expect(accountBalance(tx.lines, 'platform_revenue', null)).toBe(-2500);
  });

  it('con efectivo: el conductor cobró todo y NOS DEBE la comisión', () => {
    const tx = buildTripSettlement({
      transactionId: 'tx2', tripId: 'trip2', driverId: 'drv1', currency: 'UYU',
      fareCents: fare, commissionCents, paymentMethod: 'cash',
    });
    expect(isBalanced(tx)).toBe(true);
    // El conductor nos debe: se DEBITA su pasivo → positivo.
    // Esta línea afirmaba -2500, que era el bug: decía que le debíamos a él.
    expect(accountBalance(tx.lines, 'driver_balance', 'drv1')).toBe(2500);
    // El ingreso se ACREDITA → negativo. Antes decía +2500, o sea que un viaje
    // en efectivo REDUCÍA los ingresos de la plataforma.
    expect(accountBalance(tx.lines, 'platform_revenue', null)).toBe(-2500);
    expect(accountBalance(tx.lines, 'psp_clearing', null)).toBe(0);
    // Y en dirección legible:
    expect(driverOwedCents(tx.lines, 'drv1')).toBe(-2500);   // negativo = él nos debe
    expect(platformRevenueEarnedCents(tx)).toBe(2500);       // positivo = ganamos
  });

  /**
   * Estos tests existen porque la suma cero NO alcanza.
   *
   * En la rama de efectivo las dos patas tenían el signo invertido. La
   * transacción sumaba cero, el chequeo de integridad la aprobaba, y el test de
   * arriba afirmaba los valores equivocados: había congelado el bug. En un
   * mercado mayormente en efectivo como Uruguay, la cuenta de ingresos habría
   * quedado con el signo mal en la mayoría de los viajes.
   *
   * Lo que hay que testear es la DIRECCIÓN, no solo el balance.
   */
  describe('dirección de los asientos, no solo que sumen cero', () => {
    it('el ingreso se gana en positivo con CUALQUIER medio de pago', () => {
      for (const paymentMethod of ['cash', 'card', 'wallet'] as const) {
        const tx = buildTripSettlement({
          transactionId: `tx-${paymentMethod}`, tripId: `trip-${paymentMethod}`,
          driverId: 'drv1', currency: 'UYU',
          fareCents: fare, commissionCents, paymentMethod,
        });
        expect(platformRevenueEarnedCents(tx), `${paymentMethod} invirtió el ingreso`).toBe(2500);
        expect(isBalanced(tx)).toBe(true);
      }
    });

    it('con tarjeta le debemos al conductor; con efectivo él nos debe', () => {
      const card = buildTripSettlement({
        transactionId: 'a', tripId: 'a', driverId: 'drv1', currency: 'UYU',
        fareCents: fare, commissionCents, paymentMethod: 'card',
      });
      const cash = buildTripSettlement({
        transactionId: 'b', tripId: 'b', driverId: 'drv1', currency: 'UYU',
        fareCents: fare, commissionCents, paymentMethod: 'cash',
      });
      expect(driverOwedCents(card.lines, 'drv1')).toBeGreaterThan(0);
      expect(driverOwedCents(cash.lines, 'drv1')).toBeLessThan(0);
    });

    it('una inversión de signo pasa el chequeo de suma cero: por eso hace falta este test', () => {
      const invertido = buildTransaction({
        transactionId: 'inv', refType: 'trip', refId: 'trip-inv', currency: 'UYU',
        idempotencyKey: 'inv',
        lines: [
          { accountKind: 'driver_balance', ownerId: 'drv1', amountCents: -2500 },
          { accountKind: 'platform_revenue', ownerId: null, amountCents: 2500 },
        ],
      });
      // Suma cero: el chequeo de integridad lo aprueba...
      expect(isBalanced(invertido)).toBe(true);
      // ...pero la dirección está mal, y esto sí lo detecta.
      expect(platformRevenueEarnedCents(invertido)).toBe(-2500);
    });
  });

  it('la clave de idempotencia es estable por viaje: un reintento no duplica', () => {
    const a = buildTripSettlement({
      transactionId: 'tx3', tripId: 'trip9', driverId: 'd', currency: 'UYU',
      fareCents: fare, commissionCents, paymentMethod: 'card',
    });
    const b = buildTripSettlement({
      transactionId: 'tx4', tripId: 'trip9', driverId: 'd', currency: 'UYU',
      fareCents: fare, commissionCents, paymentMethod: 'card',
    });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  it('no permite comisión mayor a la tarifa', () => {
    expect(() =>
      buildTripSettlement({
        transactionId: 'x', tripId: 't', driverId: 'd', currency: 'UYU',
        fareCents: 1000, commissionCents: 2000, paymentMethod: 'card',
      }),
    ).toThrow(LedgerError);
  });

  it('viaje al 100 % de comisión con tarjeta sigue balanceado', () => {
    const tx = buildTripSettlement({
      transactionId: 'x', tripId: 't', driverId: 'd', currency: 'UYU',
      fareCents: 10_000, commissionCents: 10_000, paymentMethod: 'card',
    });
    expect(isBalanced(tx)).toBe(true);
  });
});

describe('ciclo completo: viaje con tarjeta + suscripción + payout', () => {
  it('el balance del conductor vuelve a cero después del payout', () => {
    const fare = 50_000;
    const { commissionCents, driverEarningsCents } = splitFare(fare, 500);

    const txs: LedgerTransaction[] = [
      buildTripSettlement({
        transactionId: 't1', tripId: 'trip1', driverId: 'drv1', currency: 'UYU',
        fareCents: fare, commissionCents, paymentMethod: 'card',
      }),
      buildSubscriptionCharge({
        transactionId: 't2', subscriptionId: 'sub1', periodStart: '2026-07-01',
        currency: 'UYU', amountCents: 280_000,
      }),
      buildPayout({
        transactionId: 't3', payoutId: 'po1', driverId: 'drv1',
        currency: 'UYU', amountCents: driverEarningsCents,
      }),
    ];

    for (const tx of txs) expect(isBalanced(tx)).toBe(true);

    const all = txs.flatMap((t) => t.lines);
    expect(accountBalance(all, 'driver_balance', 'drv1')).toBe(0);
    expect(accountBalance(all, 'platform_revenue', null)).toBe(-(2500 + 280_000));
    // Nada se pierde: el total de todas las patas del sistema es cero.
    expect(all.reduce((a, l) => a + l.amountCents, 0)).toBe(0);
  });

  it('con efectivo el conductor queda en deuda y el payout no aplica', () => {
    const fare = 27_000;                       // $270, el del smoke test
    const commissionCents = 540;               // 2 %, plan Pro
    const tx = buildTripSettlement({
      transactionId: 'c1', tripId: 'trip-cash', driverId: 'drv1', currency: 'UYU',
      fareCents: fare, commissionCents, paymentMethod: 'cash',
    });
    expect(isBalanced(tx)).toBe(true);
    // El conductor cobró $270 en la mano y nos debe $5,40.
    expect(driverOwedCents(tx.lines, 'drv1')).toBe(-540);
    expect(platformRevenueEarnedCents(tx)).toBe(540);
  });

  it('las claves de idempotencia son únicas entre tipos de operación', () => {
    const keys = new Set([
      buildTripSettlement({ transactionId: 'a', tripId: 'x', driverId: 'd', currency: 'UYU', fareCents: 1000, commissionCents: 100, paymentMethod: 'card' }).idempotencyKey,
      buildSubscriptionCharge({ transactionId: 'b', subscriptionId: 'x', periodStart: '2026-07-01', currency: 'UYU', amountCents: 1000 }).idempotencyKey,
      buildPayout({ transactionId: 'c', payoutId: 'x', driverId: 'd', currency: 'UYU', amountCents: 1000 }).idempotencyKey,
    ]);
    expect(keys.size).toBe(3);
  });

  it('rechaza suscripciones y payouts no positivos', () => {
    expect(() => buildSubscriptionCharge({ transactionId: 'a', subscriptionId: 's', periodStart: '2026-07-01', currency: 'UYU', amountCents: 0 })).toThrow(LedgerError);
    expect(() => buildPayout({ transactionId: 'a', payoutId: 'p', driverId: 'd', currency: 'UYU', amountCents: -100 })).toThrow(LedgerError);
  });
});
