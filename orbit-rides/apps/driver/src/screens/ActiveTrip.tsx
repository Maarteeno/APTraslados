import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  humanMessage, type Settlement, type Trip, type TripStatus,
} from '@orbit/client';
import { OrbitMap } from '../components/OrbitMap';
import { Banner, Button, Card, Row } from '../components/ui';
import { colors, money, radius, space } from '../theme';
import { useSession } from '../session';

/**
 * Viaje en curso, desde el punto de vista del conductor.
 *
 * Un botón por vez, y solo el que corresponde al estado actual. El servidor
 * rechaza las transiciones fuera de orden con un 409, pero ofrecer un botón que
 * va a fallar es un mal diseño: la UI tiene que reflejar lo que el servidor
 * permite, no descubrirlo a golpes.
 */
export function ActiveTripScreen({
  tripId, onFinished,
}: {
  tripId: string;
  onFinished: (settlement: Settlement | null) => void;
}): React.ReactElement {
  const { client } = useSession();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setTrip(await client.getTrip(tripId));
    } catch (err) {
      setError(humanMessage(err));
    }
  }, [client, tripId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 6000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(humanMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const complete = async (): Promise<void> => {
    if (!trip) return;
    setBusy(true);
    setError(null);
    try {
      // La distancia y la duración reales las mide la app. El servidor recalcula
      // la tarifa con estos datos, pero con un tope sobre lo cotizado: un salto
      // de GPS no puede convertirse en una tarifa arbitraria.
      const started = trip.timestamps.startedAt ? new Date(trip.timestamps.startedAt).getTime() : Date.now();
      const durationSeconds = Math.max(60, Math.round((Date.now() - started) / 1000));
      const distanceMeters = haversine(trip.origin, trip.destination) * 1.3;

      const settlement = await client.completeTrip(tripId, { distanceMeters, durationSeconds });
      onFinished(settlement);
    } catch (err) {
      setError(humanMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const status: TripStatus = trip?.status ?? 'ACCEPTED';

  return (
    <View style={styles.wrap}>
      <View style={styles.mapArea}>
        {trip && (
          <OrbitMap
            center={trip.origin}
            fitAll
            markers={[
              { id: 'o', position: trip.origin, kind: 'origin' },
              { id: 'd', position: trip.destination, kind: 'destination' },
            ]}
            route={[trip.origin, trip.destination]}
          />
        )}
      </View>

      <View style={styles.sheet}>
        <View style={styles.grip} />
        {error && <Banner text={error} tone="bad" />}

        <Text style={styles.title}>
          {status === 'ACCEPTED' && 'Andá al punto de encuentro'}
          {status === 'ARRIVED' && 'Esperando al pasajero'}
          {status === 'IN_PROGRESS' && 'En viaje'}
          {(status === 'COMPLETED' || status === 'CANCELED') && 'Viaje cerrado'}
        </Text>

        <Card>
          <Text style={styles.address} numberOfLines={2}>
            {status === 'IN_PROGRESS'
              ? (trip?.destination.address ?? 'Destino')
              : (trip?.origin.address ?? 'Punto de encuentro')}
          </Text>
          <View style={styles.divider} />
          {trip?.fareCents !== null && trip?.fareCents !== undefined && (
            <Row label="Tarifa" value={money(trip.fareCents, trip.currency)} />
          )}
          {trip?.commissionBps !== null && trip?.commissionBps !== undefined && (
            <Row label="Comisión congelada" value={`${(trip.commissionBps / 100).toFixed(2)} %`} />
          )}
          <Row
            label="Pago"
            value={trip?.paymentMethod === 'cash' ? 'Efectivo' : trip?.paymentMethod === 'card' ? 'Tarjeta' : 'Wallet'}
          />
        </Card>

        {status === 'ACCEPTED' && (
          <Button label="Llegué al origen" onPress={() => void act(() => client.markArrived(tripId))} loading={busy} />
        )}
        {status === 'ARRIVED' && (
          <Button label="Pasajero a bordo" onPress={() => void act(() => client.startTrip(tripId))} loading={busy} />
        )}
        {status === 'IN_PROGRESS' && (
          <Button label="Terminar viaje" onPress={() => void complete()} loading={busy} />
        )}
        {(status === 'ACCEPTED' || status === 'ARRIVED') && (
          <Button
            label="Cancelar viaje"
            variant="danger"
            onPress={() => void act(() => client.cancelTrip(tripId, 'cancelado por el conductor'))}
            disabled={busy}
          />
        )}
      </View>
    </View>
  );
}

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_008.8;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  mapArea: { flex: 1, backgroundColor: colors.surface },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    borderTopWidth: 1, borderColor: colors.line,
    padding: space.lg, paddingBottom: space.xl, gap: space.sm,
  },
  grip: { width: 38, height: 4, borderRadius: 2, backgroundColor: colors.line, alignSelf: 'center', marginBottom: space.sm },
  title: { color: colors.ink, fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
  address: { color: colors.ink, fontSize: 15, fontWeight: '600', lineHeight: 21 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: space.md },
});
