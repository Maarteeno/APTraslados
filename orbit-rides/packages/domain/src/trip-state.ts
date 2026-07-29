/**
 * Máquina de estados del viaje.
 *
 * Acá se rompen la mayoría de los clones de Uber: transiciones implícitas
 * disparadas desde el cliente, viajes que quedan en un estado imposible, y
 * después nadie puede reconstruir qué pasó.
 *
 * Reglas:
 *  1. Las transiciones son explícitas y están en una tabla, no repartidas en ifs.
 *  2. Solo el servidor transiciona. El cliente pide; acá se decide.
 *  3. Cada transición produce un evento append-only. `trips` es el último
 *     estado; `trip_events` es la verdad histórica.
 *  4. La comisión se congela al pasar a ACCEPTED y no se toca más.
 */

export class TripStateError extends Error {}

export const TRIP_STATUSES = [
  'REQUESTED',
  'MATCHING',
  'ACCEPTED',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELED',
  'NO_DRIVERS',
] as const;

export type TripStatus = (typeof TRIP_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TripStatus[] = ['COMPLETED', 'CANCELED', 'NO_DRIVERS'];

export type Actor = 'rider' | 'driver' | 'system';

/** Quién puede disparar cada transición. */
const TRANSITIONS: Readonly<Record<TripStatus, Readonly<Partial<Record<TripStatus, readonly Actor[]>>>>> = {
  REQUESTED: {
    MATCHING: ['system'],
    CANCELED: ['rider', 'system'],
    NO_DRIVERS: ['system'],
  },
  MATCHING: {
    ACCEPTED: ['system'],
    CANCELED: ['rider', 'system'],
    NO_DRIVERS: ['system'],
  },
  ACCEPTED: {
    ARRIVED: ['driver', 'system'],
    CANCELED: ['rider', 'driver', 'system'],
  },
  ARRIVED: {
    IN_PROGRESS: ['driver'],
    CANCELED: ['rider', 'driver', 'system'],
  },
  IN_PROGRESS: {
    COMPLETED: ['driver', 'system'],
  },
  COMPLETED: {},
  CANCELED: {},
  NO_DRIVERS: {},
};

export function isTerminal(status: TripStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function allowedTransitions(from: TripStatus): readonly TripStatus[] {
  return Object.keys(TRANSITIONS[from]) as TripStatus[];
}

export function canTransition(from: TripStatus, to: TripStatus, actor: Actor): boolean {
  const actors = TRANSITIONS[from][to];
  return actors !== undefined && actors.includes(actor);
}

export interface TransitionRequest {
  readonly from: TripStatus;
  readonly to: TripStatus;
  readonly actor: Actor;
}

export interface TripEvent {
  readonly fromStatus: TripStatus;
  readonly toStatus: TripStatus;
  readonly actor: Actor;
  readonly at: Date;
}

/**
 * Valida y produce el evento. Lanza si la transición no está permitida:
 * mejor un 409 explícito que un viaje en un estado que no existe.
 */
export function transition(req: TransitionRequest, at: Date = new Date()): TripEvent {
  if (isTerminal(req.from)) {
    throw new TripStateError(`${req.from} es terminal: no admite transiciones`);
  }
  if (!canTransition(req.from, req.to, req.actor)) {
    const allowed = allowedTransitions(req.from);
    throw new TripStateError(
      `transición no permitida ${req.from} → ${req.to} por "${req.actor}". ` +
        `Desde ${req.from} se permite: ${allowed.length ? allowed.join(', ') : '(ninguna)'}`,
    );
  }
  return { fromStatus: req.from, toStatus: req.to, actor: req.actor, at };
}

// ───────────────────────── Política de cancelación ────────────────────────────

export interface CancellationPolicy {
  /** Gracia después de ACCEPTED durante la cual cancelar no cuesta nada. */
  readonly graceSecondsAfterAccept: number;
  readonly feeCents: number;
}

export interface CancellationOutcome {
  readonly chargeable: boolean;
  readonly feeCents: number;
  readonly reason: string;
}

/**
 * Decide si una cancelación tiene cargo.
 *
 * Antes de que haya conductor asignado nunca se cobra: el pasajero no consumió
 * nada de nadie. Después de ACCEPTED, y pasada la gracia, sí — porque el
 * conductor ya se movió y dejó de estar disponible para otros viajes.
 */
export function evaluateCancellation(
  status: TripStatus,
  acceptedAt: Date | null,
  canceledBy: Actor,
  policy: CancellationPolicy,
  now: Date = new Date(),
): CancellationOutcome {
  if (canceledBy !== 'rider') {
    return { chargeable: false, feeCents: 0, reason: 'cancelación no originada por el pasajero' };
  }
  if (status === 'REQUESTED' || status === 'MATCHING') {
    return { chargeable: false, feeCents: 0, reason: 'todavía no había conductor asignado' };
  }
  if (acceptedAt === null) {
    return { chargeable: false, feeCents: 0, reason: 'sin marca de aceptación: no se cobra por las dudas' };
  }
  const elapsed = (now.getTime() - acceptedAt.getTime()) / 1000;
  if (elapsed <= policy.graceSecondsAfterAccept) {
    return {
      chargeable: false,
      feeCents: 0,
      reason: `dentro de la gracia de ${policy.graceSecondsAfterAccept}s`,
    };
  }
  return {
    chargeable: true,
    feeCents: policy.feeCents,
    reason: `${Math.round(elapsed)}s desde la aceptación, supera la gracia`,
  };
}
