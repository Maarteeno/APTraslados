/**
 * Comisión por plan.
 *
 * La comisión se CONGELA en el viaje al momento de aceptar (ver trip-state).
 * Si el conductor cambia de plan a mitad del viaje, la del viaje no se mueve.
 * Sin ese congelamiento la contabilidad es indefendible frente a una disputa.
 */

import { applyBasisPoints, assertNonNegative, type Cents } from './money.js';

export class CommissionError extends Error {}

export type PlanCode = 'free' | 'pro' | 'plus';

export interface Plan {
  readonly code: PlanCode;
  readonly monthlyFeeCents: Cents;
  readonly commissionBps: number;
  /** null = sin techo de viajes. */
  readonly maxRidesPerMonth: number | null;
}

export interface CommissionSplit {
  readonly fareCents: Cents;
  readonly commissionBps: number;
  readonly commissionCents: Cents;
  readonly driverEarningsCents: Cents;
}

export function assertPlan(plan: Plan): Plan {
  assertNonNegative(plan.monthlyFeeCents, 'monthlyFeeCents');
  if (!Number.isInteger(plan.commissionBps) || plan.commissionBps < 0 || plan.commissionBps > 10_000) {
    throw new CommissionError(`commissionBps fuera de rango: ${plan.commissionBps}`);
  }
  if (plan.maxRidesPerMonth !== null && (!Number.isInteger(plan.maxRidesPerMonth) || plan.maxRidesPerMonth <= 0)) {
    throw new CommissionError(`maxRidesPerMonth inválido: ${plan.maxRidesPerMonth}`);
  }
  return plan;
}

/** Divide la tarifa entre plataforma y conductor. Nunca pierde ni inventa un centavo. */
export function splitFare(fareCents: Cents, commissionBps: number): CommissionSplit {
  assertNonNegative(fareCents, 'fareCents');
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    throw new CommissionError(`commissionBps fuera de rango: ${commissionBps}`);
  }
  const commissionCents = applyBasisPoints(fareCents, commissionBps);
  return {
    fareCents,
    commissionBps,
    commissionCents,
    driverEarningsCents: fareCents - commissionCents,
  };
}

// ───────────────────── Salud económica del plan ──────────────────────────────

export interface ProcessingCost {
  /** Tasa variable del procesador, en basis points. */
  readonly rateBps: number;
  /** Costo fijo por transacción. */
  readonly fixedCents: Cents;
}

/**
 * Margen de la plataforma en UN viaje pagado con tarjeta.
 *
 * Existe porque es el cálculo que rompe el modelo de suscripción con comisión
 * muy baja: el procesador cobra sobre la tarifa COMPLETA, no sobre tu comisión.
 * Con comisión 2 % y procesamiento ~3,5 %, cada viaje con tarjeta da negativo.
 */
export function cardRideMarginCents(
  fareCents: Cents,
  commissionBps: number,
  serviceFeeCents: Cents,
  processing: ProcessingCost,
  variableCostCents: Cents,
): Cents {
  const { commissionCents } = splitFare(fareCents, commissionBps);
  const processingCents =
    applyBasisPoints(fareCents, processing.rateBps) + assertNonNegative(processing.fixedCents, 'fixedCents');
  return commissionCents + serviceFeeCents - processingCents - assertNonNegative(variableCostCents, 'variableCostCents');
}

/**
 * Comisión mínima (en bps) para que UN VIAJE PAGADO CON TARJETA no dé pérdida.
 *
 * Es el número estricto: supone que ese viaje concreto se paga con tarjeta y
 * por lo tanto carga el 100 % del costo de procesamiento.
 */
export function breakEvenCommissionBps(
  fareCents: Cents,
  serviceFeeCents: Cents,
  processing: ProcessingCost,
  variableCostCents: Cents,
): number {
  assertNonNegative(fareCents, 'fareCents');
  if (fareCents === 0) throw new CommissionError('fareCents no puede ser 0');
  const cost =
    applyBasisPoints(fareCents, processing.rateBps) + processing.fixedCents + variableCostCents - serviceFeeCents;
  return Math.max(0, Math.ceil((cost / fareCents) * 10_000));
}

/**
 * Comisión mínima (en bps) para que el VIAJE PROMEDIO no dé pérdida, dado que
 * solo una fracción de los viajes se paga con tarjeta.
 *
 * Existe porque las dos preguntas son distintas y confundirlas lleva a fijar
 * mal el precio:
 *
 *   - breakEvenCommissionBps        → "¿qué comisión necesito para que NINGÚN
 *                                      viaje con tarjeta pierda?"  (más alta)
 *   - blendedBreakEvenCommissionBps → "¿qué comisión necesito para que la
 *                                      operación en promedio no pierda?"
 *
 * La primera es la que importa si el conductor puede elegir cobrar todo con
 * tarjeta. La segunda es la que importa para el P&L del mes.
 */
export function blendedBreakEvenCommissionBps(
  fareCents: Cents,
  serviceFeeCents: Cents,
  processing: ProcessingCost,
  variableCostCents: Cents,
  cardShareBps: number,
): number {
  assertNonNegative(fareCents, 'fareCents');
  if (fareCents === 0) throw new CommissionError('fareCents no puede ser 0');
  if (!Number.isInteger(cardShareBps) || cardShareBps < 0 || cardShareBps > 10_000) {
    throw new CommissionError(`cardShareBps fuera de rango [0,10000]: ${cardShareBps}`);
  }
  const processingPerCardRide = applyBasisPoints(fareCents, processing.rateBps) + processing.fixedCents;
  const expectedProcessing = (processingPerCardRide * cardShareBps) / 10_000;
  const cost = expectedProcessing + variableCostCents - serviceFeeCents;
  return Math.max(0, Math.ceil((cost / fareCents) * 10_000));
}

/**
 * Facturación mensual a partir de la cual al conductor le conviene el plan caro.
 * Devuelve null si el plan caro nunca conviene (comisión igual o mayor).
 */
export function planIndifferenceGrossCents(cheaper: Plan, pricier: Plan): Cents | null {
  assertPlan(cheaper);
  assertPlan(pricier);
  const bpsSaved = cheaper.commissionBps - pricier.commissionBps;
  if (bpsSaved <= 0) return null;
  const extraFee = pricier.monthlyFeeCents - cheaper.monthlyFeeCents;
  if (extraFee <= 0) return 0;
  return Math.ceil((extraFee * 10_000) / bpsSaved);
}
