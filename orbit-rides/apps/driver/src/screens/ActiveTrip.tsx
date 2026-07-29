import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import {
  computeProgress, decodePolyline, formatArrival, humanMessage, remainingPath,
  type LatLng, type RouteStep, type Settlement, type Trip, type TripStatus,
} from '@orbit/client';
import { NavBanner } from '../components/NavBanner';
import { OrbitMap, type CameraMode } from '../components/OrbitMap';
import { Banner, Button, Card, Row } from '../components/ui';
import { colors, km, money, radius, space } from '../theme';
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
  const [position, setPosition] = useState<LatLng | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  /** Metros por segundo, como los reporta el GPS. Se convierte al mostrar. */
  const [speedMps, setSpeedMps] = useState(0);

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

  /**
   * Posición y rumbo propios, para el modo seguimiento.
   *
   * Esta pantalla mira su propio GPS en vez de recibirlo por props: la de
   * conexión se desmonta al aceptar, así que su watcher ya no está corriendo.
   *
   * `distanceInterval: 10` en vez de por tiempo: mientras el vehículo está
   * quieto no llegan actualizaciones y la cámara no tiembla; en movimiento
   * llegan cada diez metros, que a 50 km/h es algo menos de una por segundo.
   */
  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;

    void (async () => {
      const { status: permission } = await Location.requestForegroundPermissionsAsync();
      if (permission !== 'granted' || cancelled) return;
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 10 },
        (reading) => {
          setPosition({ lat: reading.coords.latitude, lng: reading.coords.longitude });
          // El rumbo solo sirve con el vehículo en marcha. Detenido, el GPS
          // devuelve valores aleatorios (y -1 cuando no lo sabe), y rotar el
          // mapa con eso lo hace girar solo. Por debajo de 2 m/s se ignora.
          const course = reading.coords.heading;
          // El GPS manda -1 cuando no sabe la velocidad, no null.
          const speed = Math.max(0, reading.coords.speed ?? 0);
          setSpeedMps(speed);
          setHeading(course !== null && course >= 0 && speed >= 2 ? course : null);
        },
      );
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  const status: TripStatus = trip?.status ?? 'ACCEPTED';
  const goingToPickup = status === 'ACCEPTED' || status === 'ARRIVED';

  /**
   * Trazado completo del tramo actual, antes de recortar lo ya recorrido.
   *
   * Antes de subir al pasajero, lo útil es cómo LLEGAR a buscarlo; ese tramo va
   * en la línea brillante. El viaje en sí queda en la tenue, como contexto: se
   * ve para dónde va la cosa sin competir con lo que hay que hacer ahora.
   * Después de subirlo se invierte y solo queda el viaje.
   *
   * Si el backend no pudo calcular un trazado —OSRM caído, o sin posición del
   * conductor al aceptar— se cae a la recta entre los dos puntos. Es peor, pero
   * orienta; un mapa sin ninguna línea no dice nada.
   */
  const fullLine: readonly LatLng[] = useMemo(() => {
    if (!trip) return [];
    const decoded = decodePolyline(goingToPickup ? trip.pickupPolyline : trip.routePolyline);
    if (decoded.length >= 2) return decoded;
    if (goingToPickup) return position ? [position, trip.origin] : [];
    return [trip.origin, trip.destination];
  }, [trip, position, goingToPickup]);

  /** Maniobras del tramo actual. */
  const steps: readonly RouteStep[] = useMemo(() => {
    if (!trip) return [];
    return goingToPickup ? trip.pickupSteps : trip.routeSteps;
  }, [trip, goingToPickup]);

  /**
   * Dónde está el conductor sobre la ruta y qué maniobra viene.
   *
   * Se recalcula en cada actualización de GPS. Es O(n) sobre el trazado y n son
   * unos cientos de puntos: irrelevante frente a un render de React Native.
   */
  const progress = useMemo(
    () => (position && fullLine.length >= 2 ? computeProgress(fullLine, steps, position) : null),
    [fullLine, steps, position],
  );

  /**
   * Umbral de desvío.
   *
   * 60 metros es más que el error de un GPS urbano —que rara vez pasa de 20 en
   * la calle— y menos que el ancho de una manzana. Por debajo, el conductor
   * está en la calle correcta aunque el punto baile; por encima, tomó otra.
   *
   * Todavía NO hay recálculo automático de ruta: se avisa y nada más. Recalcular
   * implica pedirle otra ruta al backend desde la posición actual, y conviene
   * hacerlo cuando haya cómo probarlo en la calle, no en un emulador quieto.
   */
  const offRoute = progress !== null && progress.offRouteMeters > 60;

  /**
   * Posición enganchada a la calle (map matching).
   *
   * El GPS de un teléfono tiene entre 5 y 20 metros de error en ciudad, así que
   * el punto crudo cae seguido en el medio de la manzana, sobre un techo o en
   * la vereda de enfrente. Un auto dibujado ahí se lee como un error del mapa.
   *
   * Se muestra el punto PROYECTADO sobre el trazado, que es lo que hace
   * cualquier navegador: el vehículo va siempre sobre la calle.
   *
   * Con una excepción importante: si el conductor está realmente fuera de la
   * ruta, engancharlo sería MENTIR —lo dibujaría en una calle por la que no va—
   * y justo ahí es cuando más necesita ver dónde está de verdad. Por encima del
   * umbral de desvío se usa la posición cruda.
   */
  const displayPosition: LatLng | null = useMemo(() => {
    if (!position) return null;
    if (!progress || offRoute) return position;
    return progress.snapped;
  }, [position, progress, offRoute]);

  /**
   * En navegación se dibuja SOLO lo que falta.
   *
   * Mostrar la ruta entera hace que el conductor no distinga de un vistazo qué
   * le queda, que es la única pregunta que se hace mirando el mapa. En overview
   * se muestra completa, porque ahí la pregunta es otra.
   */
  const routeLine: readonly LatLng[] = useMemo(() => {
    if (!position || fullLine.length < 2) return fullLine;
    return remainingPath(fullLine, position);
  }, [fullLine, position]);

  const contextLine: readonly LatLng[] = useMemo(() => {
    if (!trip || !goingToPickup) return [];
    const decoded = decodePolyline(trip.routePolyline);
    return decoded.length >= 2 ? decoded : [trip.origin, trip.destination];
  }, [trip, goingToPickup]);

  /**
   * Modo de cámara.
   *
   * Arranca en `overview` a propósito. Al aceptar, lo primero que el conductor
   * necesita es ENTENDER el viaje —dónde está el pasajero respecto de él, para
   * dónde sale después—, y eso no se ve con la cámara pegada a la nariz del
   * auto. Recién cuando decide arrancar aprieta "Seguirme".
   *
   * Era el bug de la primera versión: entraba directo en seguimiento con zoom
   * 16.5 y el recorrido quedaba fuera de pantalla. El conductor veía un mapa de
   * su cuadra, sin una sola línea, y ninguna pista de hacia dónde ir.
   *
   * En `follow` la pantalla es un navegador: perspectiva, auto en el tercio
   * inferior, cartel de maniobra arriba y solo el tramo que falta dibujado.
   */
  const [cameraMode, setCameraMode] = useState<CameraMode>('overview');

  /**
   * Cambio automático de modo al cambiar de tramo.
   *
   * Yendo a buscar al pasajero: `overview`. El conductor todavía está decidiendo
   * cómo encarar, y necesita ver dónde está el pasajero respecto de él.
   *
   * Con el pasajero a bordo: `follow`. Ahí ya no hay nada que decidir, hay que
   * manejar, y lo que sirve es la vista de navegación. Obligarlo a apretar un
   * botón en ese momento es pedirle que toque el teléfono justo cuando arranca.
   */
  useEffect(() => {
    setCameraMode(goingToPickup ? 'overview' : 'follow');
  }, [goingToPickup]);

  // Sin posición no se puede seguir a nadie; y con el viaje cerrado, tampoco
  // tiene sentido.
  const canFollow = displayPosition !== null &&
    (status === 'ACCEPTED' || status === 'ARRIVED' || status === 'IN_PROGRESS');
  const effectiveMode: CameraMode = canFollow ? cameraMode : 'overview';
  const navigating = effectiveMode === 'follow';

  const speedKmh = Math.round(speedMps * 3.6);

  /**
   * Hora de llegada estimada.
   *
   * Se calcula con la velocidad REAL cuando el auto se mueve, y con 30 km/h
   * —una velocidad urbana razonable— cuando está detenido. Sin ese piso, un
   * semáforo pone la llegada en el infinito y el número deja de servir.
   */
  const arrivalClock = useMemo(() => {
    if (!progress) return '--:--';
    const mps = speedMps >= 2 ? speedMps : 30 / 3.6;
    return formatArrival(progress.remainingMeters / mps);
  }, [progress, speedMps]);

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

  return (
    <View style={styles.wrap}>
      <View style={styles.mapArea}>
        {trip && (
          <OrbitMap
            // En seguimiento la cámara se pega al conductor; si todavía no hay
            // posición, el origen es el mejor centro disponible.
            // La cámara sigue la posición ENGANCHADA a la calle: si siguiera el
            // punto crudo del GPS, el mapa temblaría con cada rebote de señal.
            center={displayPosition ?? trip.origin}
            mode={effectiveMode}
            onModeChange={canFollow ? setCameraMode : undefined}
            bearing={heading}
            // La hoja inferior tapa el borde de abajo, así que el encuadre
            // necesita margen o el trazado queda por detrás de la tarjeta.
            fitPadding={56}
            // En navegación los indicadores ocupan el borde inferior.
            controlsBottom={navigating ? 76 : 12}
            markers={[
              { id: 'o', position: trip.origin, kind: 'origin' },
              { id: 'd', position: trip.destination, kind: 'destination' },
              ...(displayPosition
                ? [{ id: 'me', position: displayPosition, kind: 'driver' as const, bearing: heading }]
                : []),
            ]}
            // En navegación solo el tramo que falta; en overview, todo.
            route={navigating ? routeLine : fullLine}
            contextRoute={navigating ? [] : contextLine}
          />
        )}

        {/*
          El cartel va SOBRE el mapa y solo en navegación.
          En overview estorbaría: ahí el conductor está mirando el conjunto, no
          la próxima esquina.
        */}
        {navigating && (
          <View style={styles.bannerSlot} pointerEvents="none">
            <NavBanner
              step={progress?.step ?? null}
              distanceMeters={progress?.distanceToManeuverMeters ?? 0}
              offRoute={offRoute}
            />
          </View>
        )}

        {navigating && progress && (
          <View style={styles.hud} pointerEvents="none">
            <View style={styles.hudBox}>
              <Text style={styles.hudLabel}>Velocidad</Text>
              <Text style={styles.hudValue}>{speedKmh} km/h</Text>
            </View>
            <View style={styles.hudBox}>
              <Text style={styles.hudLabel}>Faltan</Text>
              <Text style={styles.hudValue}>{km(progress.remainingMeters)}</Text>
            </View>
            <View style={styles.hudBox}>
              <Text style={styles.hudLabel}>Llegada</Text>
              <Text style={styles.hudValue}>{arrivalClock}</Text>
            </View>
          </View>
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
  /** El cartel flota arriba del mapa, con margen para la barra de estado. */
  bannerSlot: { position: 'absolute', top: space.xl, left: space.md, right: space.md },
  /**
   * Indicadores de abajo, al estilo de un GPS de auto.
   *
   * Van sobre el mapa y no en la hoja inferior a propósito: en navegación la
   * vista tiene que leerse como una sola cosa, y meterlos en la tarjeta los
   * mezclaría con los botones de acción del viaje.
   */
  hud: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    bottom: space.md,
    flexDirection: 'row',
    gap: space.sm,
  },
  hudBox: {
    flex: 1,
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    alignItems: 'center',
    elevation: 4,
  },
  hudLabel: { color: colors.dim2, fontSize: 10, letterSpacing: 0.5 },
  hudValue: { color: colors.ink, fontSize: 15, fontWeight: '700', marginTop: 1 },
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
