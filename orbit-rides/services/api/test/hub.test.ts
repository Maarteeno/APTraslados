import { describe, it, expect, beforeEach } from 'vitest';
import type { WebSocket } from 'ws';
import { publish, subscribe, channelStats, resetHub } from '../src/ws/hub.js';

/** Socket falso: solo readyState y send, que es todo lo que el hub usa. */
function fakeSocket(readyState = 1): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState,
    sent,
    send(payload: string) { sent.push(payload); },
  } as unknown as WebSocket & { sent: string[] };
}

describe('hub de WebSocket', () => {
  beforeEach(() => resetHub());

  it('entrega a todos los suscriptores del canal', () => {
    const a = fakeSocket();
    const b = fakeSocket();
    subscribe('trip', 't1', a);
    subscribe('trip', 't1', b);
    const delivered = publish('trip', 't1', 'trip.accepted', { tripId: 't1' });
    expect(delivered).toBe(2);
    expect(JSON.parse(a.sent[0] as string)).toMatchObject({ type: 'trip.accepted' });
  });

  it('no cruza canales', () => {
    const a = fakeSocket();
    subscribe('trip', 't1', a);
    expect(publish('trip', 't2', 'x', {})).toBe(0);
    expect(publish('driver', 't1', 'x', {})).toBe(0);
    expect(a.sent).toHaveLength(0);
  });

  it('saltea sockets que no están abiertos', () => {
    const closed = fakeSocket(3); // CLOSED
    subscribe('driver', 'd1', closed);
    expect(publish('driver', 'd1', 'trip.offer', {})).toBe(0);
  });

  it('al desuscribirse limpia el canal vacío', () => {
    const a = fakeSocket();
    const off = subscribe('trip', 't1', a);
    expect(channelStats()).toEqual({ channels: 1, sockets: 1 });
    off();
    expect(channelStats()).toEqual({ channels: 0, sockets: 0 });
  });

  it('el mensaje lleva tipo y marca de tiempo', () => {
    const a = fakeSocket();
    subscribe('trip', 't1', a);
    publish('trip', 't1', 'trip.matching', { wave: 2 });
    const msg = JSON.parse(a.sent[0] as string) as { type: string; at: string; data: { wave: number } };
    expect(msg.type).toBe('trip.matching');
    expect(msg.data.wave).toBe(2);
    expect(Number.isNaN(Date.parse(msg.at))).toBe(false);
  });
});
