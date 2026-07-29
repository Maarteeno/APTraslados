/**
 * Hub de WebSocket.
 *
 * Un canal por viaje y uno por conductor. Cuando haya más de una instancia del
 * API hay que poner un adapter de Redis pub/sub acá: el hub en memoria alcanza
 * mientras corras un proceso, y es honesto decirlo antes de que sorprenda.
 */

import type { WebSocket } from 'ws';
import { logger } from '../lib/logger.js';

export type ChannelKind = 'trip' | 'driver';

export interface OutboundMessage {
  readonly type: string;
  readonly at: string;
  readonly data: unknown;
}

const channels = new Map<string, Set<WebSocket>>();

const key = (kind: ChannelKind, id: string): string => `${kind}:${id}`;

export function subscribe(kind: ChannelKind, id: string, socket: WebSocket): () => void {
  const k = key(kind, id);
  const set = channels.get(k) ?? new Set<WebSocket>();
  set.add(socket);
  channels.set(k, set);
  return () => {
    const current = channels.get(k);
    if (!current) return;
    current.delete(socket);
    if (current.size === 0) channels.delete(k);
  };
}

export function publish(kind: ChannelKind, id: string, type: string, data: unknown): number {
  const set = channels.get(key(kind, id));
  if (!set || set.size === 0) return 0;
  const message: OutboundMessage = { type, at: new Date().toISOString(), data };
  const payload = JSON.stringify(message);
  let delivered = 0;
  for (const socket of set) {
    try {
      // 1 === WebSocket.OPEN
      if (socket.readyState === 1) {
        socket.send(payload);
        delivered++;
      }
    } catch (err) {
      logger.warn({ err, channel: key(kind, id) }, 'no se pudo entregar mensaje por WebSocket');
    }
  }
  return delivered;
}

export function channelStats(): { channels: number; sockets: number } {
  let sockets = 0;
  for (const set of channels.values()) sockets += set.size;
  return { channels: channels.size, sockets };
}

/** Solo para tests. */
export function resetHub(): void {
  channels.clear();
}
