import { describe, it, expect } from 'vitest';
import {
  transition, canTransition, isTerminal, allowedTransitions, evaluateCancellation,
  TripStateError, TRIP_STATUSES, type TripStatus, type CancellationPolicy,
} from '../src/trip-state.js';

const POLICY: CancellationPolicy = { graceSecondsAfterAccept: 120, feeCents: 8000 };

describe('máquina de estados', () => {
  it('recorre el camino feliz completo', () => {
    const path: Array<[TripStatus, TripStatus, 'rider' | 'driver' | 'system']> = [
      ['REQUESTED', 'MATCHING', 'system'],
      ['MATCHING', 'ACCEPTED', 'system'],
      ['ACCEPTED', 'ARRIVED', 'driver'],
      ['ARRIVED', 'IN_PROGRESS', 'driver'],
      ['IN_PROGRESS', 'COMPLETED', 'driver'],
    ];
    for (const [from, to, actor] of path) {
      const ev = transition({ from, to, actor });
      expect(ev.toStatus).toBe(to);
    }
  });

  it('el pasajero NO puede marcar el viaje como completado', () => {
    expect(() => transition({ from: 'IN_PROGRESS', to: 'COMPLETED', actor: 'rider' })).toThrow(TripStateError);
  });

  it('el conductor NO puede autoasignarse un viaje salteando el dispatch', () => {
    expect(() => transition({ from: 'MATCHING', to: 'ACCEPTED', actor: 'driver' })).toThrow(TripStateError);
  });

  it('no se puede saltar estados', () => {
    expect(() => transition({ from: 'REQUESTED', to: 'IN_PROGRESS', actor: 'system' })).toThrow(TripStateError);
    expect(() => transition({ from: 'ACCEPTED', to: 'COMPLETED', actor: 'driver' })).toThrow(TripStateError);
  });

  it('no se puede volver atrás', () => {
    expect(() => transition({ from: 'IN_PROGRESS', to: 'ARRIVED', actor: 'driver' })).toThrow(TripStateError);
  });

  it('los estados terminales no admiten nada', () => {
    for (const t of ['COMPLETED', 'CANCELED', 'NO_DRIVERS'] as TripStatus[]) {
      expect(isTerminal(t)).toBe(true);
      expect(allowedTransitions(t)).toHaveLength(0);
      expect(() => transition({ from: t, to: 'MATCHING', actor: 'system' })).toThrow(TripStateError);
    }
  });

  it('un viaje en curso ya no se puede cancelar', () => {
    expect(canTransition('IN_PROGRESS', 'CANCELED', 'rider')).toBe(false);
    expect(canTransition('ARRIVED', 'CANCELED', 'rider')).toBe(true);
  });

  it('todos los estados están en la tabla de transiciones', () => {
    for (const s of TRIP_STATUSES) {
      expect(() => allowedTransitions(s)).not.toThrow();
    }
  });
});

describe('política de cancelación', () => {
  const accepted = new Date('2026-07-27T12:00:00Z');

  it('antes de tener conductor nunca cobra', () => {
    for (const s of ['REQUESTED', 'MATCHING'] as TripStatus[]) {
      expect(evaluateCancellation(s, null, 'rider', POLICY).chargeable).toBe(false);
    }
  });

  it('dentro de la gracia no cobra', () => {
    const r = evaluateCancellation('ACCEPTED', accepted, 'rider', POLICY, new Date(accepted.getTime() + 60_000));
    expect(r.chargeable).toBe(false);
    expect(r.feeCents).toBe(0);
  });

  it('pasada la gracia cobra el fee', () => {
    const r = evaluateCancellation('ACCEPTED', accepted, 'rider', POLICY, new Date(accepted.getTime() + 300_000));
    expect(r.chargeable).toBe(true);
    expect(r.feeCents).toBe(POLICY.feeCents);
  });

  it('si cancela el conductor no se le cobra al pasajero', () => {
    const r = evaluateCancellation('ARRIVED', accepted, 'driver', POLICY, new Date(accepted.getTime() + 900_000));
    expect(r.chargeable).toBe(false);
  });

  it('sin marca de aceptación no cobra: ante la duda, a favor del usuario', () => {
    expect(evaluateCancellation('ACCEPTED', null, 'rider', POLICY).chargeable).toBe(false);
  });
});
