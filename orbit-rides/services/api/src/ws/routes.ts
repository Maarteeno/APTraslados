/**
 * WebSocket: estado del viaje en vivo y ofertas al conductor.
 *
 * El token va por query string porque los WebSocket del navegador no permiten
 * headers propios. Es una concesión conocida: el token va sobre TLS y tiene
 * vencimiento corto.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { verifyDevToken } from '../auth/tokens.js';
import { loadConfig } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { subscribe } from './hub.js';

const querySchema = z.object({
  token: z.string().min(10),
  tripId: z.string().uuid().optional(),
});

export async function registerWebSockets(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  app.get('/v1/ws', { websocket: true, config: { public: true } }, (connection, request) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      connection.send(JSON.stringify({ type: 'error', data: { message: 'faltan token o tripId' } }));
      connection.close(1008, 'bad_request');
      return;
    }

    if (config.AUTH_MODE !== 'dev') {
      connection.send(JSON.stringify({ type: 'error', data: { message: 'auth de WebSocket no implementada para firebase' } }));
      connection.close(1008, 'unauthorized');
      return;
    }

    let userId: string;
    try {
      userId = verifyDevToken(parsed.data.token).sub;
    } catch {
      connection.close(1008, 'unauthorized');
      return;
    }

    void (async () => {
      const { rows } = await db.query<{ role: string }>(
        `SELECT role FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [userId],
      );
      const role = rows[0]?.role;
      if (!role) {
        connection.close(1008, 'unauthorized');
        return;
      }

      const unsubscribers: Array<() => void> = [];

      // El conductor escucha su canal para recibir ofertas.
      if (role === 'driver') {
        unsubscribers.push(subscribe('driver', userId, connection));
      }

      // Cualquiera de las dos partes puede escuchar un viaje del que participa.
      const tripId = parsed.data.tripId;
      if (tripId) {
        const { rows: tripRows } = await db.query<{ rider_id: string; driver_id: string | null }>(
          `SELECT rider_id, driver_id FROM trips WHERE id = $1`,
          [tripId],
        );
        const trip = tripRows[0];
        const isParticipant =
          trip !== undefined &&
          (trip.rider_id === userId || trip.driver_id === userId || role === 'admin' || role === 'support');
        if (!isParticipant) {
          connection.close(1008, 'forbidden');
          return;
        }
        unsubscribers.push(subscribe('trip', tripId, connection));
      }

      connection.send(JSON.stringify({
        type: 'connected',
        at: new Date().toISOString(),
        data: { userId, role, tripId: tripId ?? null },
      }));

      // Ping de aplicación: las redes móviles cierran conexiones idle.
      const heartbeat = setInterval(() => {
        if (connection.readyState === 1) {
          connection.send(JSON.stringify({ type: 'ping', at: new Date().toISOString(), data: null }));
        }
      }, 25_000);

      connection.on('close', () => {
        clearInterval(heartbeat);
        for (const off of unsubscribers) off();
        logger.debug({ userId }, 'WebSocket cerrado');
      });

      connection.on('error', (err: Error) => {
        logger.warn({ err, userId }, 'error en WebSocket');
      });
    })();
  });
}
