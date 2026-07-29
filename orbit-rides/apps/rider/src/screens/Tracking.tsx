import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  TripSocket, decodePolyline, humanMessage,
  type LatLng, type Settlement, type SocketMessage, type SocketState, type Trip, type TripStatus,
} from '@orbit/client';
import { OrbitMap } from '../components/OrbitMap';
import { Banner, Button, Card } from '../components/ui';
import { colors, money, radius, space } from '../theme';
import { useSession } from '../session';

const LABELS: Record<TripStatus, { title: string; detail: string }> = {
  REQUESTED:   { title: 'Pedido enviado',      detail: 'Buscando conductores cerca.' },
  MATCHING:    { title: 'Buscando conductor',  detail: 'Le ofrecemos el viaje a los más cercanos, de a uno.' },
  ACCEPTED:    { title: 'Conductor en camino', detail: 'Ya viene hacia tu punto de encuentro.' },
  ARRIVED:     { title: 'Tu conductor llegó',  detail: 'Te espera en el origen. Cinco minutos sin cargo.' },
  IN_PROGRESS: { title: 'En viaje',            detail: 'Vamos hacia tu destino.' },
  COMPLETED:   { title: 'Llegaste',            detail: 'Viaje terminado.' },
  CANCELED:    { title: 'Viaje cancelado',     detail: 'Este viaje se canceló.' },
  NO_DRIVERS:  { title: 'Sin conductores',     detail: 'No encontramos a nadie disponible. Probá de nuevo en unos minutos.' },
};

/**
 * Seguimiento del viaje en vivo.
 *
 * Dos fuentes: el WebSocket para los cambios inmediatos, y un polling lento como
 * red de contención. El WebSocket solo no alcanza —si se cae justo cuando el
 * conductor acepta, el pasajero se queda mirando "buscando conductor" para
 * siempre—, y el polling solo se siente lento. Juntos, cada uno cubre la
 * debilidad del otro.
 */
export function TrackingScreen({
  tripId, onFinished,
}: {
  tripId: string;
  onFinished: (trip: Trip, settlement: Settlement | null) => void;
}): React.ReactElement {
  const { client } = useSession();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [connection, setConnection] = useState<SocketState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const settlementRef = useRef<Settlement | null>(null);
  const finishedRef = useRef(false);

  const refresh = useCallback(async (): Promise<Trip | null> => {
    try {
      const fresh = await client.getTrip(tripId);
      setTrip(fresh);
      return fresh;
    } catch (err) {
      setError(humanMessage(err));
      return null;
    }
  }, [client, tripId]);

  /** Cierra la pantalla cuando el viaje llega a un estado terminal. */
  const finishIfDone = useCallback(
    (candidate: Trip | null) => {
      if (!candidate || finishedRef.current) return;
      const terminal: TripStatus[] = ['COMPLETED', 'CANCELED', 'NO_DRIVERS'];
      if (terminal.includes(candidate.status)) {
        finishedRef.current = true;
        onFinished(candidate, settlementRef.current);
      }
    },
    [onFinished],
  );

  useEffect(() => {
    void refresh().then(finishIfDone);
  }, [refresh, finishIfDone]);

  // WebSocket
  useEffect(() => {
    const socket = new TripSocket({
      getUrl: () => client.socketUrl(tripId),
      onStateChange: setConnection,
      onMessage: (message: SocketMessage) => {
        if (message.type === 'trip.completed') settlementRef.current = message.data;
        // Cualquier evento del viaje dispara una relectura: el mensaje avisa que
        // algo pasó, la fuente de verdad sigue siendo el servidor.
        if (message.type.startsWith('trip.')) void refresh().then(finishIfDone);
      },
      onError: () => {
        // Se ignora a propósito: la reconexión es automática y el polling cubre
        // el hueco. Mostrar un error por cada corte de red sería ruido.
      },
    });
    void socket.connect();
    return () => socket.close();
  }, [client, tripId, refresh, finishIfDone]);

  // Polling de respaldo, lento.
  useEffect(() => {
    const timer = setInterval(() => {
      void refresh().then(finishIfDone);
    }, 8000);
    return () => clearInterval(timer);
  }, [refresh, finishIfDone]);

  const cancel = async (): Promise<void> => {
    setCanceling(true);
    try {
      await client.cancelTrip(tripId, 'cancelado por el pasajero');
      finishIfDone(await refresh());
    } catch (err) {
      setError(humanMessage(err));
    } finally {
      setCanceling(false);
    }
  };

  const status = trip?.status ?? 'REQUESTED';
  const label = LABELS[status];
  const cancelable = status === 'REQUESTED' || status === 'MATCHING' || status === 'ACCEPTED' || status === 'ARRIVED';
  const chargeableCancel = status === 'ACCEPTED' || status === 'ARRIVED';

  /**
   * Qué recorrido ve el pasajero según el momento.
   *
   * Mientras el conductor viene a buscarlo, lo que le interesa es por dónde
   * viene, no el viaje que todavía no empezó. Ese trazado aparece recién cuando
   * el conductor acepta; antes no existe y se muestra el del viaje.
   */
  const waitingForPickup = trip?.status === 'ACCEPTED' || trip?.status === 'ARRIVED';

  const routeLine: readonly LatLng[] = useMemo(() => {
    if (!trip) return [];
    const decoded = decodePolyline(waitingForPickup ? trip.pickupPolyline : trip.routePolyline);
    if (decoded.length >= 2) return decoded;
    // Si el de acercamiento no existe, el del viaje sigue siendo mejor que nada.
    const fallback = decodePolyline(trip.routePolyline);
    return fallback.length >= 2 ? fallback : [trip.origin, trip.destination];
  }, [trip, waitingForPickup]);

  /**
   * El viaje en tenue mientras el conductor viene.
   *
   * El pasajero ve las dos cosas a la vez: por dónde viene el auto —brillante,
   * que es lo que está esperando— y para dónde lo va a llevar después. Es la
   * misma información que ve el conductor, que era el pedido.
   */
  const contextLine: readonly LatLng[] = useMemo(() => {
    if (!trip || !waitingForPickup) return [];
    const decoded = decodePolyline(trip.routePolyline);
    return decoded.length >= 2 ? decoded : [trip.origin, trip.destination];
  }, [trip, waitingForPickup]);

  return (
    <View style={styles.wrap}>
      <View style={styles.mapArea}>
        {trip && (
          <OrbitMap
            center={trip.origin}
            // La hoja inferior flota sobre el mapa: sin margen, el trazado
            // queda escondido detrás de la tarjeta de estado.
            fitPadding={56}
            markers={[
              { id: 'o', position: trip.origin, kind: 'origin' },
              { id: 'd', position: trip.destination, kind: 'destination' },
            ]}
            route={routeLine}
            contextRoute={contextLine}
          />
        )}
      </View>

      <View style={styles.sheet}>
        <View style={styles.grip} />

        {connection === 'reconnecting' && (
          <Banner text="Reconectando… seguimos consultando el estado del viaje." tone="warn" />
        )}
        {error && <Banner text={error} tone="bad" />}

        <Text style={styles.title}>{label.title}</Text>
        <Text style={styles.detail}>{label.detail}</Text>

        <Card style={styles.card}>
          <View style={styles.steps}>
            {(['MATCHING', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] as const).map((step) => {
              const order: TripStatus[] = ['REQUESTED', 'MATCHING', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'];
              const done = order.indexOf(status) >= order.indexOf(step);
              return <View key={step} style={[styles.step, done && styles.stepDone]} />;
            })}
          </View>
          {trip?.fareCents !== null && trip?.fareCents !== undefined && (
            <Text style={styles.fare}>{money(trip.fareCents, trip.currency)}</Text>
          )}
          <Text style={styles.method}>
            Pago: {trip?.paymentMethod === 'cash' ? 'efectivo' : trip?.paymentMethod === 'card' ? 'tarjeta' : 'wallet'}
          </Text>
        </Card>

        {cancelable && (
          <Button
            label={chargeableCancel ? 'Cancelar (puede tener cargo)' : 'Cancelar (sin cargo)'}
            variant="danger"
            onPress={() => void cancel()}
            loading={canceling}
          />
        )}
      </View>
    </View>
  );
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
  title: { color: colors.ink, fontSize: 20, fontWeight: '800', letterSpacing: -0.4 },
  detail: { color: colors.dim, fontSize: 13, lineHeight: 19 },
  card: { marginTop: space.sm },
  steps: { flexDirection: 'row', gap: space.xs, marginBottom: space.md },
  step: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.line },
  stepDone: { backgroundColor: colors.brand2 },
  fare: { color: colors.ink, fontSize: 22, fontWeight: '800' },
  method: { color: colors.dim2, fontSize: 12, marginTop: 2 },
});
